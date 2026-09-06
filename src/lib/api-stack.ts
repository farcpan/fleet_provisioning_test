import { Aws, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AppSyncAuthProvider, AppSyncAuthorizationType, EventApi } from "aws-cdk-lib/aws-appsync";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { join } from "path";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  ManagedPolicy,
  Role,
  ServicePrincipal,
  PolicyStatement
} from "aws-cdk-lib/aws-iam";
import { ContextParameters } from "../utils/context";

/**
 * API Stack
 * - for RestAPI
 * - for AppSync Events
 */
interface ApiStackProps extends StackProps {
  context: ContextParameters;
}

export class ApiStack extends Stack {
    public eventApi: EventApi;

    constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);


    // IAM Provider
    const iamProvider: AppSyncAuthProvider = { authorizationType: AppSyncAuthorizationType.IAM };
    // @FIXME Cognito Provider そのうち追加

    const eventApiName = props.context.getResourceId("appsync-event-api")
    this.eventApi = new EventApi(this, eventApiName, {
        apiName: eventApiName,
        authorizationConfig: {
            authProviders: [iamProvider],

            // @FIXME モバイル/WebアプリからのWebSocket接続
            // connectionAuthModeTypes: [AppSyncAuthorizationType.USER_POOL],
            // @FIXME モバイル/WebアプリからのSubscribe
            // defaultSubscribeAuthModeTypes: [AppSyncAuthorizationType.USER_POOL],

            // サーバ側LambdaからのみPublish: IAM認証で処理
            defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        },
    });

  }
}
