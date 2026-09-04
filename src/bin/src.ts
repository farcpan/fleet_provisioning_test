import * as cdk from "aws-cdk-lib";
import { MainStack } from "../lib/main-stack";
import { ContextParameters } from "../utils/context";

const app = new cdk.App();
const context = new ContextParameters(app);

new MainStack(app, "fleet-provisioning-test-main-stack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT!,
  },
  context: context,
});
