export function stripWrapperTags(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "giu"), "");
}
