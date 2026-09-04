import { Duration, Stack, StackProps, Aws } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { join } from "path";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnProvisioningTemplate, CfnTopicRule } from "aws-cdk-lib/aws-iot";
import {
  Effect,
  PolicyStatement,
  ServicePrincipal,
  ManagedPolicy,
  Role,
} from "aws-cdk-lib/aws-iam";

interface MainStackProps extends StackProps {
  env: {
    region: string;
    account: string;
  };
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // Lambda
    const iotTriggeredLambdaFunctionPath = join(
      __dirname,
      "../lambdas/index.ts"
    );
    const iotTriggeredlambdaFunction = new NodejsFunction(
      this,
      "FleetProvisioningTest_Function",
      {
        functionName: "FleetProvisioningTest_Function",
        entry: iotTriggeredLambdaFunctionPath,
        handler: "handler",
        logRetention: RetentionDays.ONE_DAY,
        timeout: Duration.seconds(30),
        runtime: Runtime.NODEJS_LATEST,
      }
    );

    iotTriggeredlambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["iot:*"],
        effect: Effect.ALLOW,
        resources: ["*"],
      })
    );

    /// pre Provision hook
    const preProvisionHookLambdaFunctionPath = join(
      __dirname,
      "../lambdas/hook.ts"
    );
    const preProvisionHookLambdaFunction = new NodejsFunction(
      this,
      "PreProvisionHookLambda_Function",
      {
        functionName: "PreProvisionHookLambda_Function",
        entry: preProvisionHookLambdaFunctionPath,
        handler: "handler",
        logRetention: RetentionDays.ONE_DAY,
        timeout: Duration.seconds(10),
        runtime: Runtime.NODEJS_LATEST,
        environment: {
          account: props.env.account,
          region: props.env.region,
        },
      }
    );
    preProvisionHookLambdaFunction.addPermission(
      "permission-iotcore-to-lambda",
      {
        principal: new ServicePrincipal("iot.amazonaws.com"),
      }
    );
    preProvisionHookLambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iot:CreatePolicy"],
        resources: ["*"],
      })
    );

    // IoT Core
    const timestamp = new Date().getTime();

    /// Fleet Provisioningに必要なポリシーをアタッチしたロール
    const provisioningRole = new Role(this, "test-role-for-provisioning", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      roleName: `es-test-role-for-provisioning-${timestamp}`,
      managedPolicies: [
        ManagedPolicy.fromManagedPolicyArn(
          this,
          "AWSIoTThingsRegistration",
          "arn:aws:iam::aws:policy/service-role/AWSIoTThingsRegistration"
        ),
      ],
    });

    // TemplateBody
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
          Properties: {
            CertificateId: {
              Ref: "AWS::IoT::Certificate::Id",
            },
            Status: "Active",
          },
          Type: "AWS::IoT::Certificate",
        },
        policy: {
          Type: "AWS::IoT::Policy",
          Properties: {
            PolicyName: {
              "Fn::Join": [
                "",
                [
                  "FleetProvisioningTest_Policy_",
                  {
                    Ref: "SerialNumber",
                  },
                ],
              ],
            },
          },
        },
        thing: {
          OverrideSettings: {
            AttributePayload: "MERGE",
            ThingGroups: "DO_NOTHING",
            ThingTypeName: "REPLACE",
          },
          Properties: {
            AttributePayload: {
              SerialNumber: {
                Ref: "SerialNumber",
              },
            },
            ThingGroups: [],
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
          },
          Type: "AWS::IoT::Thing",
        },
      },
    };

    // Template本体
    // preProvisioningHookで前述のLambda関数Arnを指定する
    // ThingNameは FleetProvisioningTest_Thing_{SerialNumber}で定義する
    new CfnProvisioningTemplate(this, "fleet-provisioning-template", {
      templateName: `fleet-provision-template`,
      enabled: true,
      provisioningRoleArn: provisioningRole.roleArn,
      preProvisioningHook: {
        targetArn: preProvisionHookLambdaFunction.functionArn,
      },
      templateBody: JSON.stringify(templateBodyJson),
    });

    /// Topic Rule
    new CfnTopicRule(this, "test-topic-rule", {
      ruleName: "test_topic_rule",
      topicRulePayload: {
        actions: [
          {
            lambda: {
              functionArn: iotTriggeredlambdaFunction.functionArn,
            },
          },
        ],
        sql: "SELECT topic() AS topic, clientid() AS client_id, * FROM 'mqtt/#'",
      },
    });
  }
}
