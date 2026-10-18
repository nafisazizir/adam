import type { SessionAuthContext } from "eve/context";

import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";

export const briefingAuthenticator = "briefing";

export interface BriefingSection {
  readonly name: string;
  render(): Promise<string | null> | string | null;
}

const guidance: BriefingSection = {
  name: "guidance",
  render: () =>
    [
      "It is the start of the user's day and this is your daily briefing run. Nobody asked for it, and it is not a conversation.",
      "Decide whether anything is worth a text this morning. Check:",
      "- today's upcoming reminders, with `list_reminders`. They still fire on their own, so mention one only if a heads-up helps them plan the day.",
      "- coding sessions still waiting on their answer or approval, with `list_coding_sessions`.",
      "- anything else in this chat they should know before the day starts.",
      "If something is real, send one short message covering only that. Otherwise call `stay_silent` and write no text; that is the expected outcome most mornings.",
      "This is a background turn: do not schedule, start, message, stop or merge anything, and do not call anything that waits on their confirmation.",
    ].join("\n"),
};

export const briefingSections: readonly BriefingSection[] = [guidance];

function stripBriefingTags(text: string): string {
  return text.replace(/<\s*\/?\s*briefing\b[^>]*>/giu, "");
}

async function renderSection(section: BriefingSection): Promise<string | null> {
  try {
    const text = (await section.render())?.trim();
    return text ? stripBriefingTags(text) : null;
  } catch (error) {
    console.error(`[briefing] section ${section.name} failed; leaving it out`, error);
    return null;
  }
}

export async function briefingMessage(
  timeContext: string,
  sections: readonly BriefingSection[] = briefingSections,
): Promise<string> {
  const rendered = (await Promise.all(sections.map(renderSection))).filter(
    (text): text is string => text !== null,
  );
  return [timeContext, "", "<briefing>", rendered.join("\n\n"), "</briefing>"].join("\n");
}

export function briefingAuth(owner: HomeOwner, day: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: briefingAuthenticator, attributes: { day } });
}
