import { z } from "zod";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const remindersDeliverPath = "/eve/v1/reminders/deliver";
export const workoutsStravaPath = "/eve/v1/workouts/strava";
export const workoutsHevyPath = "/eve/v1/workouts/hevy";
export const workoutsAnalyzePath = "/eve/v1/workouts/analyze";
export const workoutsNudgePath = "/eve/v1/workouts/nudge";

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
  IMESSAGE_PROJECT_ID: z.string().min(1),
  IMESSAGE_PROJECT_SECRET: z.string().min(1),
  IMESSAGE_WEBHOOK_SECRET: z.string().min(1),
  IMESSAGE_HOME_THREAD_ID: z.string().min(1),
  AI_GATEWAY_API_KEY: z.string().min(1),
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  HEVY_WEBHOOK_SECRET: z.string().min(1),
  NOTION_PLANS_DATA_SOURCE_ID: z.string().min(1),
  NOTION_WORKOUTS_DATA_SOURCE_ID: z.string().min(1),
  SPEECH_MODEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default("openai/tts-1"),
  ),
  SPEECH_VOICE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default("alloy"),
  ),
  // Vercel injects this only once a Blob store is connected, so a project
  // without one still boots; publishAsset is what fails.
  BLOB_READ_WRITE_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
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
  remindersDeliverUrl: `${parsed.data.BASE_URL}${remindersDeliverPath}`,
  workoutsAnalyzeUrl: `${parsed.data.BASE_URL}${workoutsAnalyzePath}`,
  workoutsNudgeUrl: `${parsed.data.BASE_URL}${workoutsNudgePath}`,
};
