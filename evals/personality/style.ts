import type { EveEvalContext } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

const noEmDash = z.string().refine((s) => !/—/.test(s), "uses an em-dash");

const noContrastive = z
  .string()
  .refine(
    (s) => !/\bnot\s+just\b[^.?!\n]*\bbut\b/i.test(s),
    'uses the banned "not just X, but Y" structure',
  );

const noMarkdown = z
  .string()
  .refine(
    (s) => !/(\*[^*\n]+\*)|(`[^`\n]+`)|(^#{1,6}\s+\S)/m.test(s),
    "uses markdown emphasis or headers",
  );

/**
 * The mechanical voice rules from agent/instructions.md, as reusable assertions.
 * Em-dash and the contrastive structure are hard gates (the prompt bans them
 * outright); markdown is soft because URLs and snake_case can trip the regex.
 */
export function assertHouseStyle(t: EveEvalContext): void {
  const reply = t.reply ?? "";
  t.check(reply, matches(noEmDash));
  t.check(reply, matches(noContrastive));
  t.check(reply, matches(noMarkdown)).soft();
}
