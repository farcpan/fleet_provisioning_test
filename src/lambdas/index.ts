import { PublishRequest } from "ob-appsync-events-request";

interface IoTEvent {
  topic?: string;
  client_id?: string;
  principal?: string;

  // IoT Coreから送信されたpayload
  [key: string]: unknown;
}

/**
 * IoT CoreによってトリガーされるLambda関数
 * AppSync Event APIに対してPublishする
 */
export const handler = async (event: IoTEvent): Promise<void> => {
  console.log("IoT event received:", JSON.stringify(event));
  const clientId = event.client_id;
  if (!clientId) {
    throw new Error("client_id is not included in IoT event.");
  }

  const stageName = process.env.STAGE_NAME!;
  const endpoint = process.env.APPSYNC_EVENT_HTTP_ENDPOINT!;
  const namespace = process.env.APPSYNC_CHANNEL_NAMESPACE!; // app/<stage>/<serial_number>/realtime という形式のチャンネル

  // clientIDからシリアル番号を抽出
  const serialNumber = getSerialNumber(clientId, stageName);

  // AppSync EventsAPI用のチャンネル定義
  const channel = `${namespace}/${stageName}/${serialNumber}/realtime`;

  // AppSyncにPublishする現在時刻を取得
  const currentTime = new Date().toISOString();
  const publishData = { timestamp: currentTime };
  console.log("Publishing AppSync Event:", JSON.stringify({ channel: channel, publishData: publishData }));

  // IAM署名済みPublish Requestを生成
  const request = await PublishRequest.signed(endpoint, channel, publishData);
  const response = await fetch(request);
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`AppSync Events publish failed. status=${response.status}, body=${responseBody}`);
  }
  const responseBody = await response.text();
  console.log("AppSync Events publish succeeded:", JSON.stringify({ channel, serialNumber, responseBody }));
};


// シリアル番号をClientIDから抽出する関数
const getSerialNumber = (clientId: string, stageName: string): string => {
  const prefix = `MonitorDev_${stageName}_`;
  if (!clientId.startsWith(prefix)) {
    throw new Error(
      `Invalid client_id. client_id=${clientId}`
    );
  }

  const serialNumber = clientId.substring(prefix.length);
  if (!serialNumber) {
    throw new Error(`Serial number is empty. client_id=${clientId}`);
  }
  return serialNumber;
};