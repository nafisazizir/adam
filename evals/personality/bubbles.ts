import { satisfies } from "eve/evals/expect";
import { splitBubbles } from "#lib/outbound.js";

export const MAX_BUBBLE_CHARS = 280;
export const MAX_CLOSER_CHARS = 60;

export const singleShortBubble = satisfies((reply: string) => {
  const bubbles = splitBubbles(reply);
  return bubbles.length <= 1 && (bubbles[0]?.length ?? 0) <= MAX_CLOSER_CHARS;
}, `a single bubble under ${MAX_CLOSER_CHARS} chars`);

export const briefBubbles = satisfies((reply: string) => {
  const bubbles = splitBubbles(reply);
  return bubbles.length >= 1 && bubbles.every((bubble) => bubble.length <= MAX_BUBBLE_CHARS);
}, `every bubble under ${MAX_BUBBLE_CHARS} chars`);
