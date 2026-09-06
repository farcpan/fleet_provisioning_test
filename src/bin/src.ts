import * as cdk from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack";
import { MainStack } from "../lib/main-stack";
import { ContextParameters } from "../utils/context";

const app = new cdk.App();
const context = new ContextParameters(app);

const apiStack = new ApiStack(app, context.getResourceId("api-stack"), {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT!,
    region: context.stageParameters.region,
  },
  context: context,
});

new MainStack(app, "fleet-provisioning-test-main-stack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT!,
    region: context.stageParameters.region,
  },
  context: context,
  eventApi: apiStack.eventApi,  // AppSync Event API
});
