// Owner notifications via Amazon SNS (email, or SMS if you add a phone subscription).
// Enabled when ALERT_TOPIC_ARN is set; otherwise alerts are only stored and shown.

import type { Alert } from "./store.js";

const TOPIC_ARN = process.env.ALERT_TOPIC_ARN;

export async function notifyOwner(alerts: Alert[]): Promise<number> {
  const owner = alerts.filter((a) => a.level === "owner");
  if (!TOPIC_ARN || owner.length === 0) return 0;
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const sns = new SNSClient({});
  for (const a of owner) {
    await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: `PetCheck: ${a.pet} missed ${a.label}`.slice(0, 100),
        Message: `${a.message}\n\nIf someone already did it, just tell Alexa (for example "I fed ${a.pet}") and PetCheck will log it.`,
      }),
    );
  }
  return owner.length;
}
