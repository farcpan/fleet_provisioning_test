import {
  IoTDataPlaneClient,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";

const client = new IoTDataPlaneClient({});

type Event = {
  thingName: string;
  config: Record<string, unknown>;
};

/**
 * 
 * @param event 
 * {
 *     "thingName": "thingName",
 *     "config": {
 *         "threshold": 1
 *     }
 * }
 * @returns 
 */
export const handler = async (event: Event) => {
  console.log("event:", JSON.stringify(event));

  const shadowName = process.env.SHADOW_NAME!;

  if (!event.thingName) {
    throw new Error("thingName is required");
  }

  if (!event.config || typeof event.config !== "object") {
    throw new Error("config is required");
  }

  const payload = {
    state: { desired: event.config },
  };

  console.log(
    "Update shadow:", 
    JSON.stringify(
      {
        thingName: event.thingName,
        shadowName: shadowName,
        payload,
      },
      null,
      2,
    ),
  );

  const response = await client.send(
    new UpdateThingShadowCommand({
      thingName: event.thingName,
      shadowName: shadowName,
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  const responsePayload = response.payload
    ? JSON.parse(Buffer.from(response.payload).toString("utf-8"))
    : undefined;

  console.log("UpdateThingShadow response:", JSON.stringify(responsePayload, null, 2));

  return {
    success: true,
    thingName: event.thingName,
    shadowName: shadowName,
    config: event.config,
    shadow: responsePayload,
  };
};
