// One pass over every tag at once, looped, because removing one tag can join its neighbours into
// another, even of a different name: `</bri</briefing>efing>`, or `</email_con<new_email>tent>`.
export function stripWrapperTags(text: string, ...tags: readonly string[]): string {
  if (!tags.length) return text;
  const pattern = new RegExp(`<\\s*/?\\s*(?:${tags.join("|")})\\b[^>]*>`, "giu");
  let current = text;
  for (let previous = ""; current !== previous; ) {
    previous = current;
    current = current.replace(pattern, "");
  }
  return current;
}

function attributeValue(value: string, tags: readonly string[]): string {
  return stripWrapperTags(value, ...tags).replace(/["<>\n\r]/gu, " ");
}

// `enclosing` names the wrappers this one will sit inside, so the text cannot close those either.
export function untrusted(
  tag: string,
  attributes: Record<string, string>,
  lines: readonly (string | null | undefined)[],
  enclosing: readonly string[] = [],
): string {
  const tags = [tag, ...enclosing];
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${attributeValue(value, tags)}"`)
    .join("");
  const body = stripWrapperTags(
    lines.filter((line): line is string => typeof line === "string").join("\n"),
    ...tags,
  );
  return `<${tag}${attrs}>\n${body}\n</${tag}>`;
}
