/**
 * AWS IoT Fleet Provisioning - Pre-provisioning Hook
 *
 * このLambdaでは、Fleet Provisioningを許可するデバイスかどうかを判定する。
 *
 * NOTE:
 * - IoT Policyの作成・更新は行わない。
 *   Provisioning後のデバイスには、Provisioning Templateから
 *   共通IoT Policy (BathMonitorDevicePolicy) がアタッチされる。
 * - AWS IoTのPre-provisioning Hookは5秒以内に応答する必要があるため、
 *   将来DB照合を追加する場合も、処理は軽量に保つ。
 */

interface PreProvisioningHookEvent {
  claimCertificateId?: string;
  certificateId?: string;
  certificatePem?: string;
  templateArn?: string;
  clientId?: string;
  parameters?: {
    SerialNumber?: string;
    [key: string]: string | undefined;
  };
}

interface PreProvisioningHookResponse {
  allowProvisioning: boolean;
  parameterOverrides: Record<string, string>;
}

/**
 * シリアル番号がProvisioning許可対象かを判定する。
 *
 * 現時点では、SerialNumberが指定されていれば許可する。
 *
 * 将来的には、ここでAWS上のDB（例: DynamoDB）を参照し、
 * 事前登録されたシリアル番号であることを確認する。
 *
 * 例:
 *   1. SerialNumberをキーにDynamoDBからデバイス情報を取得
 *   2. デバイスが事前登録済みであることを確認
 *   3. 必要に応じて「未Provisioning」であることも確認
 *   4. 条件を満たす場合のみ true を返す
 *
 * DBアクセス失敗時は、安全側に倒して false を返す設計を推奨する。
 */
const isSerialNumberProvisioningAllowed = async (serialNumber: string): Promise<boolean> => {
  // TODO:
  // 将来、ここにシリアル番号とAWS上のDBを照合する処理を実装する。
  //
  // 例:
  // const result = await dynamoDbClient.send(
  //   new GetCommand({
  //     TableName: process.env.DEVICE_TABLE_NAME,
  //     Key: {
  //       serialNumber,
  //     },
  //   })
  // );
  //
  // return result.Item?.provisioningAllowed === true;

  return true;
};

/**
 * Pre-provisioning Hook handler
 */
export const handler = async (event: PreProvisioningHookEvent): Promise<PreProvisioningHookResponse> => {
  try {
    const serialNumber = event.parameters?.SerialNumber?.trim();

    if (!serialNumber) {
      console.warn("Provisioning denied: SerialNumber is missing.");
      return {
        allowProvisioning: false,
        parameterOverrides: {},
      };
    }

    console.log("Pre-provisioning request received.", {
      serialNumber,
      claimCertificateId: event.claimCertificateId,
      certificateId: event.certificateId,
      clientId: event.clientId,
      templateArn: event.templateArn,
    });

    const allowed = await isSerialNumberProvisioningAllowed(serialNumber);

    if (!allowed) {
      console.warn("Provisioning denied: SerialNumber is not allowed.", {
        serialNumber,
      });

      return {
        allowProvisioning: false,
        parameterOverrides: {},
      };
    }

    console.log("Provisioning allowed.", {
      serialNumber,
    });

    return {
      allowProvisioning: true,
      parameterOverrides: {},
    };
  } catch (error) {
    // 予期しないエラーが発生した場合は、Provisioningを許可しない。
    // セキュリティ上、fail-openではなくfail-closedとする。
    console.error("Pre-provisioning hook failed.", error);

    return {
      allowProvisioning: false,
      parameterOverrides: {},
    };
  }
};
