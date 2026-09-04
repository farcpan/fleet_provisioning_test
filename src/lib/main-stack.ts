import { Aws, Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { join } from "path";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  CfnPolicy,
  CfnPolicyPrincipalAttachment,
  CfnProvisioningTemplate,
  CfnTopicRule,
} from "aws-cdk-lib/aws-iot";
import {
  ManagedPolicy,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { ContextParameters } from "../utils/context";

interface MainStackProps extends StackProps {
  env: {
    account: string;
  };

  context: ContextParameters;
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const accountId = props.env.account;
    const region = props.context.stageParameters.region;

    // プロビジョニング用テンプレート定義
    const provisioningTemplateName = "fleet-provision-template";
    const provisioningTemplateArn = `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + `provisioningtemplate/${provisioningTemplateName}`;

    // デバイスポリシー定義
    const devicePolicyName = "DevicePolicy";

    // Fleet Provisioning用のClaim証明書にアタッチするポリシー定義
    const claimPolicyName = "FleetProvisioningClaimPolicy";

    // ---------------------------------------------------------------------
    // Lambda: 通常のMQTTメッセージ処理
    // ---------------------------------------------------------------------
    const iotTriggeredLambdaFunctionPath = join(__dirname, "../lambdas/index.ts");
    const iotTriggeredLambdaFunction = new NodejsFunction(this, "FleetProvisioningTest_Function", {
      functionName: "FleetProvisioningTest_Function",
      entry: iotTriggeredLambdaFunctionPath,
      handler: "handler",
      logRetention: RetentionDays.ONE_DAY,
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
    const preProvisionHookLambdaFunction = new NodejsFunction(this, "PreProvisionHookLambda_Function", {
      functionName: "PreProvisionHookLambda_Function",
      entry: preProvisionHookLambdaFunctionPath,
      handler: "handler",
      logRetention: RetentionDays.ONE_DAY,
      // AWS IoTのPre-provisioning hookは5秒以内に応答する必要がある。
      timeout: Duration.seconds(5),
      runtime: Runtime.NODEJS_22_X,
      environment: {
        account: accountId,
        region: region,
      },
    });

    // IoT CoreからPre-provisioning hook Lambdaを呼び出すための権限。
    // sourceAccount/sourceArnを指定して呼び出し元を限定する。
    preProvisionHookLambdaFunction.addPermission("AllowIoTPreProvisioningHookInvoke", {
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
    const thingNamePolicyVariable = "${iot:Connection.Thing.ThingName}";
    const deviceTopicPrefix = `mqtt/${thingNamePolicyVariable}`;  // Topicは必ず mqtt/<thing_name>/+/+/... という形式とする

    const devicePolicy = new CfnPolicy(this, "DeviceIoTPolicy", {
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
          {
            Effect: "Allow",
            Action: ["iot:Publish", "iot:PublishRetain", "iot:Receive"],
            Resource: [`arn:${Aws.PARTITION}:iot:${region}:${accountId}:topic/${deviceTopicPrefix}/*`],
          },
          {
            Effect: "Allow",
            Action: ["iot:Subscribe"],
            Resource: [`arn:${Aws.PARTITION}:iot:${region}:${accountId}:topicfilter/${deviceTopicPrefix}/*`],
          },
        ],
      },
    });

    // ---------------------------------------------------------------------
    // IoT Policy: Claim Certificate用
    // ---------------------------------------------------------------------
    // CSR方式では、Claim CertificateでAWS IoTへ接続した後 $aws/certificates/create-from-csr/json にCSRをPublishし、
    // 取得したcertificateOwnershipTokenを使ってRegisterThingを行う。
    const claimPolicy = new CfnPolicy(this, "FleetProvisioningClaimPolicy", {
      policyName: claimPolicyName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["iot:Connect"],
            Resource: ["*"],
          },
          {
            Effect: "Allow",
            Action: ["iot:Publish", "iot:Receive"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + "topic/$aws/certificates/create-from-csr/*",
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + `topic/$aws/provisioning-templates/${provisioningTemplateName}/provision/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: ["iot:Subscribe"],
            Resource: [
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + "topicfilter/$aws/certificates/create-from-csr/*",
              `arn:${Aws.PARTITION}:iot:${region}:${accountId}:` + `topicfilter/$aws/provisioning-templates/${provisioningTemplateName}/provision/*`,
            ],
          },
        ],
      },
    });

    // Claim Certificate自体は秘密鍵の安全な生成・配布が必要なため、
    // このStackでは生成しない。既存証明書ARNが渡された場合のみPolicyを付与する。
    if (props.context.stageParameters.iot.claimCertificateArn) {
      const claimPolicyAttachment = new CfnPolicyPrincipalAttachment(this, "FleetProvisioningClaimPolicyAttachment", {
        policyName: claimPolicyName,
        principal: props.context.stageParameters.iot.claimCertificateArn,
      });
      claimPolicyAttachment.addResourceDependency(claimPolicy);
    }

    // ---------------------------------------------------------------------
    // Fleet Provisioning role
    // ---------------------------------------------------------------------
    // AWS IoT CoreがThing/Certificate/Policyの関連付けを作成するためのRole。
    // roleNameは固定せずCDK/CloudFormationに任せ、deployごとのRole置換を避ける。
    const provisioningRole = new Role(this, "FleetProvisioningRole", {
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
                  "FleetProvisioningTest_Thing_",
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

    const provisioningTemplate = new CfnProvisioningTemplate(
      this,
      "FleetProvisioningTemplate",
      {
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
    const topicRuleName = "test_topic_rule";
    const topicRuleArn = `arn:${Aws.PARTITION}:iot:${region}:${accountId}:rule/${topicRuleName}`;

    // デバイスからPublishされたデータをLambdaへ渡す。
    new CfnTopicRule(this, "DeviceMonitorTopicRule", {
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
        sql: "SELECT topic() AS topic, clientid() AS client_id, * FROM 'mqtt/#'",
      },
    });

    // IoT Topic Rule -> LambdaのInvoke権限。
    iotTriggeredLambdaFunction.addPermission("AllowIoTTopicRuleInvoke", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
      sourceAccount: accountId,
      sourceArn: topicRuleArn,
    });
  }
}
