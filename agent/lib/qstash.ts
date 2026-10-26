import { Client, Receiver } from "@upstash/qstash";

import { env } from "#lib/env.js";

const client = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });

// The free plan's ceiling; a later instant goes through lib/timer.ts, which hops toward it.
export const maxDelaySeconds = 7 * 24 * 60 * 60;

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

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function hasValidCallbackSignature(request: Request, body: string, url: string): Promise<boolean> {
  try {
    return await verifyCallbackSignature({
      signature: request.headers.get("upstash-signature") ?? "",
      body,
      url,
    });
  } catch {
    return false;
  }
}

export async function cancelCallback(messageId: string): Promise<"cancelled" | "gone"> {
  try {
    await client.messages.cancel(messageId);
    return "cancelled";
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return "gone";
    throw error;
  }
}
