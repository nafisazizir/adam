type ContentNode = Record<string, unknown>;

function attachmentNodes(content: unknown): ContentNode[] {
  if (typeof content !== "object" || content === null) return [];
  const node = content as ContentNode;
  if (node.type === "attachment" || node.type === "voice") return [node];
  if (node.type === "reply") return attachmentNodes(node.content);
  if (node.type === "group" && Array.isArray(node.items)) {
    return node.items.flatMap((item) =>
      attachmentNodes(typeof item === "object" && item !== null ? (item as ContentNode).content : undefined),
    );
  }
  return [];
}

function hasDownloadId(node: ContentNode): boolean {
  return typeof node.id === "string" && node.id.length > 0;
}

type SpectrumPlatform = {
  client?: unknown;
  config?: unknown;
  store?: unknown;
  definition?: { actions?: { getMessage?: unknown } };
};

type SpectrumApp = {
  __internal?: { platforms?: { get?: (name: string) => SpectrumPlatform | undefined } };
};

type GetMessage = (
  ctx: { client?: unknown; config?: unknown; store?: unknown },
  space: unknown,
  messageId: string,
) => Promise<{ content?: unknown } | undefined>;

// Spectrum's webhook voice payload omits the attachment GUID, so Eve can't wire fetchData.
export async function resolveAttachmentIds(raw: unknown, spectrumApp: unknown): Promise<void> {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as ContentNode;
  const nodes = attachmentNodes(record.content);
  if (nodes.every(hasDownloadId)) return;
  if (typeof record.id !== "string" || record.id.length === 0) return;
  if (typeof record.space !== "object" || record.space === null) return;

  const platform = (spectrumApp as SpectrumApp | null | undefined)?.__internal?.platforms?.get?.(
    "iMessage",
  );
  const getMessage = platform?.definition?.actions?.getMessage;
  if (typeof getMessage !== "function" || platform === undefined) return;

  const resolved = await (getMessage as GetMessage)(
    { client: platform.client, config: platform.config, store: platform.store },
    record.space,
    record.id,
  );
  const resolvedNodes = attachmentNodes(resolved?.content);
  nodes.forEach((node, index) => {
    const resolvedNode = resolvedNodes[index];
    if (!hasDownloadId(node) && resolvedNode !== undefined && hasDownloadId(resolvedNode)) {
      node.id = resolvedNode.id;
    }
  });
}

export function unreadableInbound(message: {
  text: string;
  attachments: readonly unknown[];
  raw: unknown;
}): Record<string, unknown> | null {
  const raw =
    typeof message.raw === "object" && message.raw !== null ? (message.raw as ContentNode) : {};
  const content =
    typeof raw.content === "object" && raw.content !== null ? (raw.content as ContentNode) : null;
  const nodes = attachmentNodes(raw.content);

  const undownloadable = nodes.some((node) => !hasDownloadId(node));
  const unknownContent = message.text.trim().length === 0 && message.attachments.length === 0;
  if (!undownloadable && !unknownContent) return null;

  return {
    contentType: typeof content?.type === "string" ? content.type : null,
    contentKeys: content ? Object.keys(content) : [],
    rawKeys: Object.keys(raw),
    nodes: nodes.map((node) => ({
      type: node.type,
      keys: Object.keys(node),
      name: node.name,
      mimeType: node.mimeType,
      size: node.size,
    })),
  };
}

function field(node: unknown, key: string): unknown {
  return typeof node === "object" && node !== null ? (node as ContentNode)[key] : undefined;
}

// Apple authenticates an iMessage handle; an SMS or RCS originator can be spoofed. Photon's webhook
// sender carries only `platform`, the gateway's sender also `service`. Only a sender explicitly marked
// as another service is refused: failing closed on a missing field would lock the owner out.
export function sentOverAnotherService(raw: unknown): boolean {
  const sender = field(raw, "sender");
  const service = field(sender, "service") ?? field(sender, "platform") ?? field(raw, "platform");
  return typeof service === "string" && service.toLowerCase() !== "imessage";
}
