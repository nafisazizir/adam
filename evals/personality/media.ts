import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const URL_IN_TEXT = /https?:\/\/[^\s)>\]]+/g;

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((m) => m[0]);
}

/**
 * Every url in the reply must have come back from a tool in that turn. A url
 * the model wrote from memory is a dead link dressed up as an attachment.
 */
export function assertMediaProvenance(t: EveEvalContext, turn: EveEvalTurn): void {
  const returned = new Set(
    turn.toolCalls.flatMap((call) => urlsIn(JSON.stringify(call.output ?? ""))),
  );
  const invented = urlsIn(turn.message ?? "").filter((url) => !returned.has(url));

  t.check(
    invented,
    satisfies(() => invented.length === 0, "every url in the reply was returned by a tool"),
  ).label("media provenance");
}
