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
export const codingSessionsWatchPath = "/eve/v1/coding-sessions/watch";
export const codingSessionsNotifyPath = "/eve/v1/coding-sessions/notify";

// An empty assignment such as `KEY=` in a .env file means unset, not an empty value.
function blankAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
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
  IMESSAGE_PROJECT_ID: z.string().min(1),
  IMESSAGE_PROJECT_SECRET: z.string().min(1),
  IMESSAGE_WEBHOOK_SECRET: z.string().min(1),
  OWNER_IMESSAGE_USER_ID: blankAsUnset(z.string().trim().min(1).optional()),
  AI_GATEWAY_API_KEY: z.string().min(1),
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: blankAsUnset(z.string().min(1).optional()),
  HEVY_WEBHOOK_SECRET: z.string().min(1),
  NOTION_PLANS_DATA_SOURCE_ID: z.string().min(1),
  NOTION_WORKOUTS_DATA_SOURCE_ID: z.string().min(1),
  TRANSCRIPTION_MODEL: blankAsUnset(z.string().min(1).default("microsoft/mai-transcribe-2")),
  SPEECH_MODEL: blankAsUnset(z.string().min(1).default("openai/tts-1")),
  SPEECH_VOICE: blankAsUnset(z.string().min(1).default("alloy")),
  // Vercel injects this only once a Blob store is connected, so a project
  // without one still boots; publishAsset is what fails.
  BLOB_READ_WRITE_TOKEN: blankAsUnset(z.string().min(1).optional()),
  QSTASH_URL: blankAsUnset(z.string().min(1).optional()),
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
  RIZ_MCP_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, "")),
  RIZ_MCP_JWT_SECRET: z.string().min(1),
  // Optional so a deploy without Devin credentials still boots; only the coding tools fail.
  DEVIN_API_KEY: blankAsUnset(z.string().min(1).optional()),
  DEVIN_ORG_ID: blankAsUnset(z.string().min(1).optional()),
  DEVIN_MAX_ACU_LIMIT: blankAsUnset(z.coerce.number().int().positive().optional()),
  VERCEL: blankAsUnset(z.string().min(1).optional()),
  VERCEL_ENV: blankAsUnset(z.string().min(1).optional()),
  VERCEL_TARGET_ENV: blankAsUnset(z.string().min(1).optional()),
  // Vercel system env for a Git-connected project: the repo this agent is built from.
  VERCEL_GIT_REPO_OWNER: blankAsUnset(z.string().min(1).optional()),
  VERCEL_GIT_REPO_SLUG: blankAsUnset(z.string().min(1).optional()),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const { VERCEL, VERCEL_ENV, VERCEL_TARGET_ENV, VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG } = parsed.data;

export const env = {
  ...parsed.data,
  deployment: { onVercel: Boolean(VERCEL), environment: VERCEL_TARGET_ENV ?? VERCEL_ENV },
  selfRepo:
    VERCEL_GIT_REPO_OWNER && VERCEL_GIT_REPO_SLUG
      ? `${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}`
      : undefined,
  remindersDeliverUrl: `${parsed.data.BASE_URL}${remindersDeliverPath}`,
  workoutsAnalyzeUrl: `${parsed.data.BASE_URL}${workoutsAnalyzePath}`,
  workoutsNudgeUrl: `${parsed.data.BASE_URL}${workoutsNudgePath}`,
  codingSessionsWatchUrl: `${parsed.data.BASE_URL}${codingSessionsWatchPath}`,
  codingSessionsNotifyUrl: `${parsed.data.BASE_URL}${codingSessionsNotifyPath}`,
};
