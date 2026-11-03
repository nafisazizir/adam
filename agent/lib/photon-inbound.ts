type ContentNode = Record<string, unknown>;

interface InboundMessage {
  text: string;
  readonly attachments: readonly unknown[];
  readonly raw: unknown;
}

function field(node: unknown, key: string): unknown {
  return typeof node === "object" && node !== null ? (node as ContentNode)[key] : undefined;
}

function strings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const text = typeof value === "string" ? value : field(value, "value");
    return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
  });
}

function vcardUrls(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [...raw.matchAll(/^(?:item\d+\.)?URL[^:\r\n]*:(.+)$/gimu)].map((match) =>
    match[1]!.trim().replace(/\\:/gu, ":"),
  );
}

function contactName(name: unknown): string {
  const formatted = field(name, "formatted");
  if (typeof formatted === "string") return formatted;
  return ["first", "last"]
    .map((key) => field(name, key))
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

export function contactCardText(content: unknown): string | null {
  if (field(content, "type") === "reply") return contactCardText(field(content, "content"));
  if (field(content, "type") !== "contact") return null;
  const details = [
    contactName(field(content, "name")),
    ...strings(field(content, "phones")),
    ...strings(field(content, "emails")),
    ...vcardUrls(field(content, "raw")),
  ].filter((detail) => detail.trim().length > 0);
  return `[Shared a contact card: ${details.length > 0 ? details.join(", ") : "no details"}]`;
}

// Eve builds a turn from a message's text and files only, so a contact card or a shared location
// (both vCards) carries neither and would be dropped without a reply. Writes the card in as text,
// and returns what is left unreadable so the caller can log it.
export function fillInboundWithoutContent(message: InboundMessage): Record<string, unknown> | null {
  if (message.text.trim().length > 0 || message.attachments.length > 0) return null;
  const content = field(message.raw, "content");
  const card = contactCardText(content);
  if (card !== null) {
    message.text = card;
    return null;
  }
  return {
    contentType: field(content, "type") ?? null,
    contentKeys: typeof content === "object" && content !== null ? Object.keys(content) : [],
  };
}

const spoofableServices = new Set(["sms", "rcs"]);

// Apple authenticates an iMessage handle; an SMS or RCS originator can be spoofed. Photon's webhook
// sender carries only `platform`, the gateway's sender also `service`. Only a sender explicitly marked
// as another service is refused: failing closed on a missing field would lock the owner out.
export function sentOverAnotherService(raw: unknown): boolean {
  const sender = field(raw, "sender");
  const service = field(sender, "service") ?? field(sender, "platform") ?? field(raw, "platform");
  return typeof service === "string" && spoofableServices.has(service.toLowerCase());
}
