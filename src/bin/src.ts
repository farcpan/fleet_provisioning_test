import * as cdk from "aws-cdk-lib";
import { MainStack } from "../lib/main-stack";

const app = new cdk.App();
new MainStack(app, "fleet-provisioning-test-main-stack", {
  env: {
    region: "ap-northeast-1",
    account: "910136156309",
  },
});
