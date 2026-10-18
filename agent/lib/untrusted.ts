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

function attributeValue(value: string, tag: string): string {
  return stripWrapperTags(value, tag).replace(/["<>\n\r]/gu, " ");
}

export function untrusted(
  tag: string,
  attributes: Record<string, string>,
  lines: readonly (string | null | undefined)[],
): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${attributeValue(value, tag)}"`)
    .join("");
  const body = stripWrapperTags(
    lines.filter((line): line is string => typeof line === "string").join("\n"),
    tag,
  );
  return `<${tag}${attrs}>\n${body}\n</${tag}>`;
}
