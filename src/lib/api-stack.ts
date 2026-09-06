import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AppSyncAuthorizationType, EventApi } from "aws-cdk-lib/aws-appsync";
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

    const eventApiName = props.context.getResourceId("appsync-event-api")
    this.eventApi = new EventApi(this, eventApiName, {
        apiName: eventApiName,
        authorizationConfig: {
            authProviders: [
                // ここにCognitoProviderも追加する @FIXME
                {
                    authorizationType: AppSyncAuthorizationType.IAM
                }
            ],

            // @FIXME モバイル/WebアプリからのWebSocket接続
            connectionAuthModeTypes: [
                AppSyncAuthorizationType.IAM,
                //AppSyncAuthorizationType.USER_POOL
            ],
            // @FIXME モバイル/WebアプリからのSubscribe
            defaultSubscribeAuthModeTypes: [
                AppSyncAuthorizationType.IAM,
                //AppSyncAuthorizationType.USER_POOL
            ],

            // サーバ側LambdaからのみPublish: IAM認証で処理
            defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        },
    });

    // Namespace(Pub/sub用のトピック)を追加
    this.eventApi.addChannelNamespace(props.context.getResourceId("app-namespace"), {
        channelNamespaceName: "app",
        authorizationConfig: {
            publishAuthModeTypes: [
                AppSyncAuthorizationType.IAM,
            ],

            // AppSync Event APIの認証方法と合わせる必要がある（将来的にCognito認証に変更） @FIXME
            subscribeAuthModeTypes: [
                AppSyncAuthorizationType.IAM,
            ],
        },
    })
  }
}
