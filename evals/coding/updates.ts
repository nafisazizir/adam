import type { CodingUpdate } from "#lib/coding-sessions.js";

const session = {
  sessionId: "devin-7f3a9c",
  title: "Add Google Calendar access",
  url: "https://app.devin.ai/sessions/7f3a9c",
};

export const needsInputUpdate: CodingUpdate = {
  ...session,
  state: "needs_input",
  pullRequests: [],
  latestMessage:
    "I've mapped out the calendar integration. Before I wire up OAuth: should Adam get read-only access to your calendar, or should it also be able to create and move events? Read-only needs a smaller scope and no consent screen review.",
};

export const finishedUpdate: CodingUpdate = {
  ...session,
  state: "finished",
  pullRequests: [{ url: "https://github.com/nafisazizir/adam/pull/42", state: "open" }],
  latestMessage: [
    "Done! I opened https://github.com/nafisazizir/adam/pull/42.",
    "",
    "Summary:",
    "- Added a user-scoped Google Calendar connection through Vercel Connect, shared by root Adam.",
    "- Added `block_calendar_time` and `list_calendar_events` tools with zod schemas.",
    "- Updated instructions.md and spec.md.",
    "",
    "Verification: pnpm typecheck and eve build both pass; I exercised the tools against a mocked Calendar API.",
    "",
    "Manual steps: run `eve add connection/google-calendar --skip-install` and attach it to the Vercel project, then set GOOGLE_CALENDAR_ID in Vercel.",
  ].join("\n"),
};
