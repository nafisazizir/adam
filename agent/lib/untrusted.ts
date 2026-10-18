// Loops because removing one tag can join its neighbours into a new one: `</bri</briefing>efing>`.
// Several tags go in one pattern, so removing one can't rebuild another either.
export function stripWrapperTags(text: string, tag: string | readonly string[]): string {
  const names = typeof tag === "string" ? tag : tag.join("|");
  const pattern = new RegExp(`<\\s*/?\\s*(?:${names})\\b[^>]*>`, "giu");
  let current = text;
  for (let previous = ""; current !== previous; ) {
    previous = current;
    current = current.replace(pattern, "");
  }
  return current;
}
