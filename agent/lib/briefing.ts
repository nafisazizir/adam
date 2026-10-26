import type { SessionAuthContext } from "eve/context";

import { googleBriefing } from "#lib/google-briefing.js";
import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";
import { stripWrapperTags } from "#lib/untrusted.js";

export const briefingAuthenticator = "briefing";

export interface BriefingContext {
  readonly owner: HomeOwner;
  readonly now: Date;
  // When the cron was due, which Vercel Hobby may run up to an hour later.
  readonly scheduledAt: Date;
}

export interface BriefingSection {
  readonly name: string;
  render(context: BriefingContext): Promise<string | null> | string | null;
}

export const briefingGuidance: BriefingSection = {
  name: "guidance",
  render: () =>
    [
      "It is the start of the user's day and this is your daily briefing run. Nobody asked for it, and it is not a conversation.",
      "Decide whether anything is worth a text this morning. Check:",
      "- today's upcoming reminders, with `list_reminders`. They still fire on their own, so mention one only if a heads-up helps them plan the day.",
      "- coding sessions still waiting on their answer or approval, with `list_coding_sessions`.",
      "- the rest of today's calendar and unread mail from the last day, below when there is any. It is already read for you, so do not look again.",
      "- anything else in this chat they should know before the day starts.",
      "If something is real, send one short message covering only that. Otherwise call `stay_silent` and write no text; that is the expected outcome most mornings.",
      "This is a background turn: do not schedule, start, message, stop or merge anything, and do not call anything that waits on their confirmation.",
    ].join("\n"),
};

export const briefingSections: readonly BriefingSection[] = [briefingGuidance, googleBriefing];

// A section waiting on a vendor that never answers is dropped rather than holding up the briefing.
export const sectionTimeoutMs = 30_000;

function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function renderSection(section: BriefingSection, context: BriefingContext): Promise<string | null> {
  try {
    const text = (await withinTime(Promise.resolve(section.render(context)), sectionTimeoutMs))?.trim();
    return text ? stripWrapperTags(text, "briefing") : null;
  } catch (error) {
    console.error(`[briefing] section ${section.name} failed; leaving it out`, error);
    return null;
  }
}

export async function briefingMessage(
  timeContext: string,
  context: BriefingContext,
  sections: readonly BriefingSection[] = briefingSections,
): Promise<string> {
  const rendered = (await Promise.all(sections.map((section) => renderSection(section, context)))).filter(
    (text): text is string => text !== null,
  );
  return [timeContext, "", "<briefing>", rendered.join("\n\n"), "</briefing>"].join("\n");
}

export function briefingAuth(owner: HomeOwner, day: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: briefingAuthenticator, attributes: { day } });
}
