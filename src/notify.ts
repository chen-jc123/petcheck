// Owner notifications via Amazon SNS (email, or SMS if you add a phone subscription).
// Enabled when ALERT_TOPIC_ARN is set; otherwise the owner messages are only logged,
// and the alerts are still stored and shown on the household page.
// Sent: owner-level missed-task alerts, and the day-before vet visit reminders.

import { isVetReminder, type Alert } from "./store.js";

const TOPIC_ARN = process.env.ALERT_TOPIC_ARN;

export interface OwnerMessage {
  subject: string;
  message: string;
}
export type Publish = (msg: OwnerMessage) => Promise<void>;

/** Which alerts reach the owner directly. */
export const notifiesOwner = (a: Alert) => a.level === "owner" || isVetReminder(a);

export function ownerMessage(a: Alert): OwnerMessage {
  if (isVetReminder(a)) {
    return { subject: `PetCheck: ${a.pet}'s vet visit is tomorrow`.slice(0, 100), message: a.message.replace(/^Reminder:\s*/, "") };
  }
  return {
    subject: `PetCheck: ${a.pet} missed ${a.label}`.slice(0, 100),
    message: `${a.message}\n\nIf someone already did it, just tell Alexa (for example "I fed ${a.pet}") and PetCheck will log it.`,
  };
}

let sns: Publish | undefined;
async function snsPublish(msg: OwnerMessage): Promise<void> {
  if (!sns) {
    const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
    const client = new SNSClient({});
    sns = async (m) => {
      await client.send(new PublishCommand({ TopicArn: TOPIC_ARN, Subject: m.subject, Message: m.message }));
    };
  }
  return sns(msg);
}

/** Send the owner messages for these alerts; returns how many were sent. */
export async function notifyOwner(alerts: Alert[], publish: Publish | undefined = TOPIC_ARN ? snsPublish : undefined): Promise<number> {
  const owner = alerts.filter(notifiesOwner);
  if (owner.length === 0) return 0;
  if (!publish) {
    for (const a of owner) console.log(`owner notification (not sent: ALERT_TOPIC_ARN not set): ${ownerMessage(a).subject}`);
    return 0;
  }
  for (const a of owner) await publish(ownerMessage(a));
  return owner.length;
}
