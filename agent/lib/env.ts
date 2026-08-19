import { z } from "zod";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const schema = z.object({
  USER_TIMEZONE: z
    .string()
    .min(1)
    .default("Australia/Brisbane")
    .refine(isValidTimeZone, "must be a valid IANA time zone name"),
  BASE_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, "")),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  IMESSAGE_PROJECT_ID: z.string().min(1),
  IMESSAGE_PROJECT_SECRET: z.string().min(1),
  IMESSAGE_WEBHOOK_SECRET: z.string().min(1),
  AI_GATEWAY_API_KEY: z.string().min(1),
  QSTASH_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
  RIZ_MCP_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, "")),
  RIZ_MCP_JWT_SECRET: z.string().min(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = {
  ...parsed.data,
  remindersDeliverUrl: `${parsed.data.BASE_URL}/eve/v1/reminders/deliver`,
};
