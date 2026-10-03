import { Client, Receiver } from "@upstash/qstash";

import { env } from "#lib/env.js";

const client = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
});

export async function publishCallback(input: {
  url: string;
  body: unknown;
  delaySeconds?: number;
  deduplicationId?: string;
}): Promise<string> {
  const res = (await client.publishJSON({
    url: input.url,
    body: input.body,
    ...(input.delaySeconds === undefined ? {} : { delay: input.delaySeconds }),
    ...(input.deduplicationId === undefined
      ? {}
      : { deduplicationId: input.deduplicationId }),
  })) as { messageId: string } | { messageId: string }[];

  return Array.isArray(res) ? res[0].messageId : res.messageId;
}

export function verifyCallbackSignature(input: {
  signature: string;
  body: string;
  url: string;
}): Promise<boolean> {
  return receiver.verify(input);
}

export async function publishReminder(input: {
  message: string;
  channel: string;
  target: Record<string, unknown>;
  delaySeconds: number;
}): Promise<string> {
  return publishCallback({
    url: env.remindersDeliverUrl,
    body: { message: input.message, channel: input.channel, target: input.target },
    delaySeconds: input.delaySeconds,
  });
}

export async function cancelReminder(messageId: string): Promise<void> {
  await client.messages.cancel(messageId);
}

export function verifyReminderSignature(input: {
  signature: string;
  body: string;
}): Promise<boolean> {
  return verifyCallbackSignature({
    signature: input.signature,
    body: input.body,
    url: env.remindersDeliverUrl,
  });
}
