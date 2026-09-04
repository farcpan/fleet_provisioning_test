// import { CreatePolicyCommand, IAMClient } from "@aws-sdk/client-iam";
import { IoTClient, CreatePolicyCommand } from "@aws-sdk/client-iot";

export const handler = async (event: any, context: any) => {
  const region = process.env["region"];
  const account = process.env["account"];
  if (!region || !account) {
    console.error("region & account required.");
    return {
      allowProvisioning: false,
    };
  }

  const serialNumber = event["parameters"]["SerialNumber"];
  console.log(`SerialNumber: ${serialNumber}`);

  // SerialNumberを使ってポリシーを作成する
  try {
    const client = new IoTClient();
    await client.send(
      new CreatePolicyCommand({
        policyName: "FleetProvisioningTest_Policy_" + serialNumber,
        policyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["iot:Connect", "iot:Receive"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["iot:Publish"],
              Resource: `arn:aws:iot:${region}:${account}:topic/mqtt/${serialNumber}/*`,
            },
            {
              Effect: "Allow",
              Action: ["iot:Subscribe"],
              Resource: `arn:aws:iot:${region}:${account}:topicFilter/mqtt/${serialNumber}/*`,
            },
          ],
        }),
      })
    );
  } catch (e) {
    console.error(e);
    return {
      allowProvisioning: false,
    };
  }

  return {
    allowProvisioning: true,
  };
};
