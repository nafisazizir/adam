// Loops because removing one tag can join its neighbours into a new one: `</bri</briefing>efing>`.
export function stripWrapperTags(text: string, tag: string): string {
  const pattern = new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "giu");
  let current = text;
  for (let previous = ""; current !== previous; ) {
    previous = current;
    current = current.replace(pattern, "");
  }
  return current;
}
