import { Aws, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { join } from "path";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  CfnPolicy,
  CfnPolicyPrincipalAttachment,
  CfnProvisioningTemplate,
  CfnTopicRule,
  CfnAccountAuditConfiguration,
  CfnScheduledAudit,
} from "aws-cdk-lib/aws-iot";
import {
  ManagedPolicy,
  Role,
  ServicePrincipal,
  PolicyStatement
} from "aws-cdk-lib/aws-iam";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { ContextParameters } from "../utils/context";

// !! 注意事項 !!
///////////////////////////////////////////////////////////////////////////
// - Topic定義には必ず環境名（prd/stg/devなど）を入れ、通信が混在しないようにすること
// - 現状の実装では、シリアル番号からThingNameを構築する際に、MonitorDev_{stageName}_{serialNumber}としている。
//   証明書取得後のMQTT接続時のClient IDは必ずThingNameと一致させること。
// - Claim時にはClientIDを "provision_{serialNumber}"とする必要がある。
// - AWS IoT Core が生成する X.509 クライアント証明書は、現行仕様では 2049-12-31 23:59:59 UTC 固定
///////////////////////////////////////////////////////////////////////////

interface MainStackProps extends StackProps {
  env: {
    account: string;
    region: string;
  };

  context: ContextParameters;
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const accountId = props.env.account;
    const region = props.env.region;
    const stageName = props.context.stage;

    // プロビジョニング用テンプレート定義
    const provisioningTemplateName = `fleet-provision-template-${stageName}`;
    const provisioningTemplateArn = `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + `provisioningtemplate/${provisioningTemplateName}`;

    // デバイスポリシー定義
    const devicePolicyName = `DevicePolicy${stageName.toUpperCase()}`;

    // Fleet Provisioning用のClaim証明書にアタッチするポリシー定義
    const claimPolicyName = `FleetProvisioningClaimPolicy${stageName.toUpperCase()}`;

    // ---------------------------------------------------------------------
    // Lambdaログ出力用LogGroup定義
    // ---------------------------------------------------------------------
    const iotCoreLambdaLogGroup = new LogGroup(this, props.context.getResourceId("lambda-log-group"),
      {
        logGroupName: `/device_monitor/${stageName}/lambda/iot_core`,
        retention: RetentionDays.ONE_DAY,
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    // ---------------------------------------------------------------------
    // Lambda: 通常のMQTTメッセージ処理
    // ---------------------------------------------------------------------
    const iotTriggeredLambdaFunctionPath = join(__dirname, "../lambdas/index.ts");
    const iotTriggeredLambdaFunctionName = props.context.getResourceId("iot-trigger-fn")
    const iotTriggeredLambdaFunction = new NodejsFunction(this, iotTriggeredLambdaFunctionName, {
      functionName: iotTriggeredLambdaFunctionName,
      entry: iotTriggeredLambdaFunctionPath,
      handler: "handler",
      logGroup: iotCoreLambdaLogGroup,
      timeout: Duration.seconds(30),
      runtime: Runtime.NODEJS_22_X,
    });

    // NOTE:
    // 元コードにあった iot:* は削除した。
    // このLambdaからIoT Control Plane APIを呼ぶ必要がある場合のみ、
    // DescribeThing等の必要なActionを個別に追加すること。

    // ---------------------------------------------------------------------
    // Lambda: Pre-provisioning hook
    // ---------------------------------------------------------------------
    const preProvisionHookLambdaFunctionPath = join(__dirname, "../lambdas/hook.ts");
    const preProvisionHookLambdaFunctionName = props.context.getResourceId("pre-provision-fn")
    const preProvisionHookLambdaFunction = new NodejsFunction(this, preProvisionHookLambdaFunctionName, {
      functionName: preProvisionHookLambdaFunctionName,
      entry: preProvisionHookLambdaFunctionPath,
      handler: "handler",
      logGroup: iotCoreLambdaLogGroup,
      // AWS IoTのPre-provisioning hookは5秒以内に応答する必要がある。
      timeout: Duration.seconds(5),
      runtime: Runtime.NODEJS_22_X,
    });

    // IoT CoreからPre-provisioning hook Lambdaを呼び出すための権限。
    // sourceAccount/sourceArnを指定して呼び出し元を限定する。
    const preProvisionHookLambdaPermissionId = props.context.getResourceId("pre-provision-hook-permission")
    preProvisionHookLambdaFunction.addPermission(preProvisionHookLambdaPermissionId, {
      principal: new ServicePrincipal("iot.amazonaws.com"),
      sourceAccount: accountId,
      sourceArn: provisioningTemplateArn,
    });

    // NOTE:
    // Pre-provisioning hookではPolicyを生成しない。
    // hook.tsはSerialNumber等を検証し、以下の形式を返すことを想定する。
    // {
    //   allowProvisioning: true,
    //   parameterOverrides: {}
    // }

    // ---------------------------------------------------------------------
    // IoT Policy: Provisioning後に全デバイスで共有するPolicy
    // ---------------------------------------------------------------------
    // Thing Policy Variablesを使い、1デバイスが自分自身のTopicだけを Publish/Subscribe/Receive できるようにする。
    const thingNamePolicyVariable = "${iot:Connection.Thing.ThingName}";  // ポリシー内にThingNameを埋め込むことでデバイスと証明書を1:1とする
    const deviceTopicPrefix = `mqtt/${stageName}/${thingNamePolicyVariable}`;  // Topicは必ず mqtt/<stage_name>/<thing_name>/+/+/... という形式とする
    const jobsTopicPrefix = `$aws/things/${thingNamePolicyVariable}/jobs`;  // IoT Jobsを扱うための特殊なトピック

    const devicePolicyId = props.context.getResourceId("device-policy")
    const devicePolicy = new CfnPolicy(this, devicePolicyId, {
      policyName: devicePolicyName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["iot:Connect"],
            Resource: [`arn:${Aws.PARTITION}:iot:${region}:${accountId}:client/${thingNamePolicyVariable}`],
            Condition: {
              Bool: { "iot:Connection.Thing.IsAttached": "true" },
            },
          },
          // !!注意!!
          // 厳密には、Publish/Subscribeするトピックは異なるので、より細かな権限設定が可能
          // 現時点ではトピック設計が定まっていないため、 "mqtt/${stageName}/${thingNamePolicyVariable}" で統一する
          {
            Effect: "Allow",
            Action: ["iot:Publish", "iot:RetainPublish", "iot:Receive"],  // RetainPublishは暫定仕様として入れておく
            Resource: [`arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/${deviceTopicPrefix}/*`],
          },
          {
            Effect: "Allow",
            Action: ["iot:Subscribe"],
            Resource: [`arn:${Aws.PARTITION}:iot:${region}:${accountId}:topicfilter/${deviceTopicPrefix}/*`],
          },

          // IoT Jobs用のポリシー
          {
            Effect: "Allow",
            Action: [
              "iot:Publish",
              "iot:Receive",
            ],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/${jobsTopicPrefix}/*`,
            ],
          },

          // Job通知・accepted/rejected等のSubscribe
          {
            Effect: "Allow",
            Action: ["iot:Subscribe"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topicfilter/${jobsTopicPrefix}/*`,
            ],
          },
        ],
      },
    });

    // ---------------------------------------------------------------------
    // IoT Policy: Claim Certificate用
    // ---------------------------------------------------------------------
    // CSR方式では、Claim CertificateでAWS IoTへ接続した後 $aws/certificates/create-from-csr/json にCSRをPublishし、
    // 取得したcertificateOwnershipTokenを使ってRegisterThingを行う。
    const claimPolicyId = props.context.getResourceId("fleet-provision-claim-policy")
    const claimPolicy = new CfnPolicy(this, claimPolicyId, {
      policyName: claimPolicyName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["iot:Connect"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:client/provision-*`  // Claim時に接続可能なClientIDを = "provision-{serialNumber}"に限定する
            ],
          },
          {
            Effect: "Allow",
            Action: ["iot:Publish"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/certificates/create-from-csr/json`,
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/provisioning-templates/${provisioningTemplateName}/provision/json`,
            ],
          },
          {
            Effect: "Allow",
            Action: ["iot:Receive"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/certificates/create-from-csr/json/accepted`,
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/certificates/create-from-csr/json/rejected`,
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/provisioning-templates/${provisioningTemplateName}/provision/json/accepted`,
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/$aws/provisioning-templates/${provisioningTemplateName}/provision/json/rejected`,
            ],
          },
          {
            Effect: "Allow",
            Action: ["iot:Subscribe"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topicfilter/$aws/certificates/create-from-csr/*`,
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:topicfilter/$aws/provisioning-templates/${provisioningTemplateName}/provision/*`,
            ],
          },
        ],
      },
    });

    // Claim Certificate自体は秘密鍵の安全な生成・配布が必要なため、
    // このStackでは生成しない。既存証明書ARNが渡された場合のみPolicyを付与する。
    if (!props.context.stageParameters.iot.claimCertificateArn) {
      throw new Error("iot.claimCertificateArn is required for Fleet Provisioning.");
    }
    const claimPolicyAttachId = props.context.getResourceId("fleet-provision-claim-policy-attachment")
    const claimPolicyAttachment = new CfnPolicyPrincipalAttachment(this, claimPolicyAttachId, {
      policyName: claimPolicyName,
      principal: props.context.stageParameters.iot.claimCertificateArn,
    });
    claimPolicyAttachment.addResourceDependency(claimPolicy);

    // ---------------------------------------------------------------------
    // Fleet Provisioning role
    // ---------------------------------------------------------------------
    // AWS IoT CoreがThing/Certificate/Policyの関連付けを作成するためのRole
    const provisionRoleId = props.context.getResourceId("fleet-provisioning-role");
    const provisioningRole = new Role(this, provisionRoleId, {
      roleName: provisionRoleId,
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSIoTThingsRegistration"
        ),
      ],
    });

    // ---------------------------------------------------------------------
    // Fleet Provisioning Template
    // ---------------------------------------------------------------------
    // CSRそのものはRegisterThingでは渡さない。
    // デバイスは先にCreateCertificateFromCsrを実行し、AWS IoTが返した
    // certificateId / certificateOwnershipTokenを使ってRegisterThingする。
    // そのためTemplateではAWS::IoT::Certificate::Idを参照する。
    const templateBodyJson = {
      Parameters: {
        SerialNumber: {
          Type: "String",
        },
        "AWS::IoT::Certificate::Id": {
          Type: "String",
        },
      },
      Resources: {
        certificate: {
          Type: "AWS::IoT::Certificate",
          Properties: {
            CertificateId: {
              Ref: "AWS::IoT::Certificate::Id",
            },
            Status: "ACTIVE", // Provisioning後にデバイスを有効化する
            ThingPrincipalType: "EXCLUSIVE_THING",  // 証明書とThingを1:1とする
          },
        },
        policy: {
          Type: "AWS::IoT::Policy",
          Properties: {
            // Fn::Join等でデバイスごとのPolicy名を生成しない。
            // 事前作成した共通IoT Policyを全デバイスへアタッチする。
            PolicyName: devicePolicyName,
          },
        },
        thing: {
          Type: "AWS::IoT::Thing",
          Properties: {
            ThingName: {
              "Fn::Join": [
                "",
                [
                  `MonitorDev_${stageName}_`, // ThingName内に環境名を入れておく
                  {
                    Ref: "SerialNumber",
                  },
                ],
              ],
            },
            AttributePayload: {
              SerialNumber: {
                Ref: "SerialNumber",
              },
            },
            ThingGroups: [],
          },
          OverrideSettings: {
            AttributePayload: "MERGE",
            ThingGroups: "DO_NOTHING",
            ThingTypeName: "REPLACE",
          },
        },
      },
    };

    const provisioningTemplate = new CfnProvisioningTemplate(this, provisioningTemplateName, {
        templateName: provisioningTemplateName,
        enabled: true,
        provisioningRoleArn: provisioningRole.roleArn,
        preProvisioningHook: {
          targetArn: preProvisionHookLambdaFunction.functionArn,
        },
        templateBody: JSON.stringify(templateBodyJson),
      }
    );

    // Provisioning Templateが共通Device Policyより先に作成されないようにする。
    // Template内では既存PolicyNameを参照するため、この依存関係を明示する。
    provisioningTemplate.addResourceDependency(devicePolicy);

    // ---------------------------------------------------------------------
    // IoT Topic Rule
    // ---------------------------------------------------------------------
    // トピックルール
    const topicRuleName = `test_topic_rule_${stageName}`;
    const topicRuleArn = `arn:${Aws.PARTITION}:iot:${region}:${accountId}:rule/${topicRuleName}`;

    // デバイスからPublishされたデータをLambdaへ渡す。
    new CfnTopicRule(this, topicRuleName, {
      ruleName: topicRuleName,
      topicRulePayload: {
        actions: [
          {
            lambda: {
              functionArn: iotTriggeredLambdaFunction.functionArn,
            },
          },
        ],
        awsIotSqlVersion: "2016-03-23",
        sql: `SELECT topic() AS topic, clientid() AS client_id, principal() AS principal, * FROM 'mqtt/${stageName}/#'`,
      },
    });

    // IoT Topic Rule -> LambdaのInvoke権限
    const iotTriggerLambdaFnPermissionId = props.context.getResourceId("iot-trigger-lambda-fn-permission");
    iotTriggeredLambdaFunction.addPermission(iotTriggerLambdaFnPermissionId, {
      principal: new ServicePrincipal("iot.amazonaws.com"),
      sourceAccount: accountId,
      sourceArn: topicRuleArn,
    });


    // ---------------------------------------------------------------------
    // Device Defender監査
    // ---------------------------------------------------------------------
    // 監査用Role
    const auditRoleId = props.context.getResourceId("iot-device-defender-audit-role");
    const auditRole = new Role(this, auditRoleId, {
      roleName: auditRoleId,
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSIoTDeviceDefenderAudit"
        ),
      ],
    });

    // 監査結果をSNS経由で通知する
    const defenderAuditNotificationTopicId = props.context.getResourceId("iot-defender-audit-notification-topic");
    const defenderAuditNotificationTopic = new Topic(this, defenderAuditNotificationTopicId, { topicName: defenderAuditNotificationTopicId });
    const certificateRotationRequestLambdaFunctionPath = join(__dirname, "../lambdas/certificate-rotation-request.ts");
    const certificateRotationRequestLambdaFunctionName = props.context.getResourceId("certificate-rotation-request-fn");
    const certificateRotationRequestLambdaFunction = new NodejsFunction(this, certificateRotationRequestLambdaFunctionName, {
      functionName: certificateRotationRequestLambdaFunctionName,
      entry: certificateRotationRequestLambdaFunctionPath,
      handler: "handler",
      logGroup: iotCoreLambdaLogGroup,
      timeout: Duration.minutes(5),
      runtime: Runtime.NODEJS_22_X,
      environment: {
        STAGE_NAME: stageName,
        ACCOUNT_ID: accountId,
        PARTITION: Aws.PARTITION,
      },
    });

    // IoT監査結果取得・IoT Job作成権限をLambdaに与えるためのポリシー
    certificateRotationRequestLambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "iot:ListAuditFindings",
          "iot:ListPrincipalThingsV2",
          "iot:CreateJob",
        ],
        resources: ["*"],
      })
    );

    // Topicに、Lambdaを起動するSubscriptionを追加
    defenderAuditNotificationTopic.addSubscription(new LambdaSubscription(certificateRotationRequestLambdaFunction));

    // Device DefenderがSNSへPublishできるようにRole付与
    defenderAuditNotificationTopic.grantPublish(auditRole);

    // 監査設定
    const auditConfigurationId = props.context.getResourceId("iot-account-audit-config");
    const auditConfiguration = new CfnAccountAuditConfiguration(this, auditConfigurationId, {
      accountId: accountId,
      roleArn: auditRole.roleArn,

      // 監査に通知方法を定義
      auditNotificationTargetConfigurations: {
        sns: {
          enabled: true,
          roleArn: auditRole.roleArn,
          targetArn: defenderAuditNotificationTopic.topicArn,
        },
      },

      auditCheckConfigurations: {
        // 運用上の定期ローテーション
        deviceCertificateAgeCheck: {
          enabled: true,
          configuration: {
            certAgeThresholdInDays: "1",  // 1日で通知
          },
        },

        // X.509証明書そのものの期限切れ監視
        deviceCertificateExpiringCheck: {
          enabled: true,
        },
      },
    });

    // 監査スケジュール
    const scheuledAuditId = props.context.getResourceId("iot-cert-daily-audit");
    const scheduledAudit = new CfnScheduledAudit(this, scheuledAuditId, {
      // scheduledAuditName: scheuledAuditId,
      frequency: "DAILY",
      targetCheckNames: [
        "DEVICE_CERTIFICATE_AGE_CHECK",
        "DEVICE_CERTIFICATE_EXPIRING_CHECK",
      ],
    });

    scheduledAudit.addResourceDependency(auditConfiguration);

  }
}
