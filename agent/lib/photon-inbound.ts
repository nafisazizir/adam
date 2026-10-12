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
