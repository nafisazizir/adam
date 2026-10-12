import heicDecode from "heic-decode";
import sharp from "sharp";
import type { ChannelDefinition } from "eve/channels";

export type FetchFileResult = Exclude<
  Awaited<ReturnType<NonNullable<ChannelDefinition["fetchFile"]>>>,
  null | Buffer
>;

const INLINE_IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;
const PROVIDER_SAFE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const HEIC_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

const MAX_DIMENSION = 2048;

export async function normalizeInboundFile(
  file: FetchFileResult,
  fallbackMediaType?: string,
): Promise<FetchFileResult> {
  const mediaType = file.mediaType ?? fallbackMediaType;
  if (mediaType === undefined || !mediaType.startsWith("image/")) return file;
  if (
    PROVIDER_SAFE_IMAGE_TYPES.has(mediaType) &&
    file.bytes.byteLength <= INLINE_IMAGE_LIMIT_BYTES
  ) {
    return file;
  }

  try {
    const image = HEIC_TYPES.has(mediaType)
      ? await heicToRawInput(file.bytes)
      : sharp(file.bytes);
    const bytes = await image
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { bytes, mediaType: "image/jpeg", filename: jpegFilename(file.filename) };
  } catch (error) {
    console.warn("[inbound-media:image.unreadable]", {
      mediaType,
      bytes: file.bytes.byteLength,
      error,
    });
    throw new Error(`Unreadable ${mediaType} image attachment.`);
  }
}

async function heicToRawInput(bytes: Buffer) {
  const { width, height, data } = await heicDecode({ buffer: bytes });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  });
}

function jpegFilename(filename: string | undefined): string {
  const stem = filename?.replace(/\.[^.]*$/, "").trim();
  return `${stem && stem.length > 0 ? stem : "image"}.jpg`;
}

type FetchFileFn = (
  url: string,
  context?: { state: Readonly<Record<string, unknown>> },
) => Promise<Buffer | FetchFileResult | null>;

export function withInboundMediaNormalization<T>(channel: T): T {
  const adapter = (channel as { adapter?: { fetchFile?: FetchFileFn } }).adapter;
  const original = adapter?.fetchFile;
  if (adapter === undefined) return channel;
  Object.assign(adapter, {
    fetchFile: async (
      url: string,
      context?: { state: Readonly<Record<string, unknown>> },
    ): Promise<Buffer | FetchFileResult | null> => {
      if (original === undefined) return null;
      const result = await original(url, context);
      if (result === null) return null;
      const file = Buffer.isBuffer(result) ? { bytes: result } : result;
      return normalizeInboundFile(file);
    },
  });
  return channel;
}
