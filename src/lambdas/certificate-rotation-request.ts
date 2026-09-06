import type { SNSEvent } from "aws-lambda";
import {
  CreateJobCommand,
  IoTClient,
  ListAuditFindingsCommand,
  ListPrincipalThingsV2Command,
} from "@aws-sdk/client-iot";

const iotClient = new IoTClient({});

const STAGE_NAME = process.env.STAGE_NAME!;
const ACCOUNT_ID = process.env.ACCOUNT_ID!;
const PARTITION = process.env.PARTITION ?? "aws";
const REGION = process.env.AWS_REGION!;

const TARGET_CHECKS = [
  "DEVICE_CERTIFICATE_AGE_CHECK",
  "DEVICE_CERTIFICATE_EXPIRING_CHECK",
] as const;

type TargetCheckName = (typeof TARGET_CHECKS)[number];

type AuditNotification = {
  accountId?: string;
  taskId?: string;
  taskStatus?: string;
  taskType?: string;
  auditDetails?: Array<{
    checkName?: string;
    checkRunStatus?: string;
    nonCompliantResourcesCount?: number;
    totalResourcesCount?: number;
  }>;
};

type RotationCandidate = {
  certificateId: string;
  checkName: TargetCheckName;
  reasonCode?: string;
  findingId?: string;
};

export const handler = async (event: SNSEvent): Promise<void> => {
  console.info("Received Device Defender audit notification", {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    const notification = parseAuditNotification(record.Sns.Message);

    if (!notification.taskId) {
      console.warn("Audit notification does not contain taskId. Skip.");
      continue;
    }

    if (notification.taskStatus && notification.taskStatus !== "COMPLETED") {
      console.info("Audit task is not completed. Skip.", {
        taskId: notification.taskId,
        taskStatus: notification.taskStatus,
      });
      continue;
    }

    const candidates = await collectRotationCandidates(notification.taskId);

    console.info("Certificate rotation candidates collected", {
      taskId: notification.taskId,
      count: candidates.length,
    });

    // 同一監査で同じ証明書がAGE/EXPIRINGの両方に該当しても、1回だけJobを作る。
    // EXPIRINGを後勝ちにして、より強い理由をJob documentへ残す。
    const candidatesByCertificate = new Map<string, RotationCandidate>();
    for (const candidate of candidates) {
      const current = candidatesByCertificate.get(candidate.certificateId);
      if (!current || candidate.checkName === "DEVICE_CERTIFICATE_EXPIRING_CHECK") {
        candidatesByCertificate.set(candidate.certificateId, candidate);
      }
    }

    for (const candidate of candidatesByCertificate.values()) {
      await requestCertificateRotation(notification.taskId, candidate);
    }
  }
};

function parseAuditNotification(message: string): AuditNotification {
  try {
    return JSON.parse(message) as AuditNotification;
  } catch (error) {
    console.error("Failed to parse Device Defender SNS message", {
      error,
      message,
    });
    throw error;
  }
}

async function collectRotationCandidates(taskId: string): Promise<RotationCandidate[]> {
  const candidates: RotationCandidate[] = [];

  for (const checkName of TARGET_CHECKS) {
    let nextToken: string | undefined;

    do {
      const result = await iotClient.send(
        new ListAuditFindingsCommand({
          taskId,
          checkName,
          maxResults: 250,
          nextToken,
          // Suppress済みFindingは自動ローテーション対象から除外する。
          listSuppressedFindings: false,
        })
      );

      for (const finding of result.findings ?? []) {
        const certificateId =
          finding.nonCompliantResource?.resourceIdentifier?.deviceCertificateId;

        if (!certificateId) {
          console.warn("Audit finding does not contain deviceCertificateId", {
            taskId,
            checkName,
            findingId: finding.findingId,
          });
          continue;
        }

        candidates.push({
          certificateId,
          checkName,
          reasonCode: finding.reasonForNonComplianceCode,
          findingId: finding.findingId,
        });
      }

      nextToken = result.nextToken;
    } while (nextToken);
  }

  return candidates;
}

async function requestCertificateRotation(
  auditTaskId: string,
  candidate: RotationCandidate
): Promise<void> {
  const certificateId = candidate.certificateId.replace(/^0x/i, "");
  const certificateArn = `arn:${PARTITION}:iot:${REGION}:${ACCOUNT_ID}:cert/${certificateId}`;

  const principalThings = await iotClient.send(
    new ListPrincipalThingsV2Command({
      principal: certificateArn,
      thingPrincipalType: "EXCLUSIVE_THING",
      maxResults: 10,
    })
  );

  const thingNames = (principalThings.principalThingObjects ?? [])
    .map((item) => item.thingName)
    .filter((thingName): thingName is string => Boolean(thingName));

  if (thingNames.length !== 1) {
    // 現行ProvisioningはEXCLUSIVE_THING前提なので、0件/複数件は構成異常として自動処理しない。
    console.error("Certificate is not attached to exactly one exclusive Thing", {
      certificateId,
      thingNames,
    });
    return;
  }

  const thingName = thingNames[0];
  const expectedPrefix = `MonitorDev_${STAGE_NAME}_`;

  if (!thingName.startsWith(expectedPrefix)) {
    // 同一AWSアカウント内の別IoTシステムへ誤ってJobを作らないための防御。
    console.error("Thing does not belong to this stage", {
      certificateId,
      thingName,
      expectedPrefix,
    });
    return;
  }

  const thingArn = `arn:${PARTITION}:iot:${REGION}:${ACCOUNT_ID}:thing/${thingName}`;

  // 監査は毎日実行されるため、同じ旧証明書について毎日Jobを増殖させない。
  // certificateId由来の決定的なjobIdを使い、CreateJobのResourceAlreadyExistsExceptionを
  // 「すでにローテーション要求済み」として扱う。
  const jobId = buildRotationJobId(certificateId);

  const jobDocument = {
    schemaVersion: 1,
    operation: "ROTATE_CERTIFICATE",
    certificateId,
    source: "AWS_IOT_DEVICE_DEFENDER_AUDIT",
    auditTaskId,
    auditCheckName: candidate.checkName,
    reasonCode: candidate.reasonCode,
    requestedAt: new Date().toISOString(),
  };

  try {
    await iotClient.send(
      new CreateJobCommand({
        jobId,
        targets: [thingArn],
        targetSelection: "SNAPSHOT",
        description: `Rotate device certificate for ${thingName}`,
        document: JSON.stringify(jobDocument),
      })
    );

    console.info("Certificate rotation job created", {
      jobId,
      thingName,
      certificateId,
      checkName: candidate.checkName,
    });
  } catch (error) {
    if (isResourceAlreadyExists(error)) {
      console.info("Certificate rotation job already exists. Skip duplicate request.", {
        jobId,
        thingName,
        certificateId,
      });
      return;
    }

    console.error("Failed to create certificate rotation job", {
      jobId,
      thingName,
      certificateId,
      error,
    });
    throw error;
  }
}

function buildRotationJobId(certificateId: string): string {
  // IoT JobsのjobIdは最大64文字。
  // certificateIdは実質的に一意なので、その先頭52文字を利用する。
  return `cert-rotate-${certificateId.slice(0, 52)}`;
}

function isResourceAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as { name?: string }).name === "ResourceAlreadyExistsException";
}
