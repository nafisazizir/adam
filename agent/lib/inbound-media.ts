import heicDecode from "heic-decode";
import sharp from "sharp";
import type { ChannelDefinition } from "eve/channels";

export type FetchFileResult = Exclude<
  Awaited<ReturnType<NonNullable<ChannelDefinition["fetchFile"]>>>,
  null | Buffer
>;

const INLINE_IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;
const HEIC_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

const MAX_DIMENSION = 2048;

export async function toProviderSafeImage(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Buffer; mediaType: string } | null> {
  const sniffedMediaType = sniffProviderSafeImageType(bytes);
  if (
    sniffedMediaType !== undefined &&
    bytes.byteLength <= INLINE_IMAGE_LIMIT_BYTES
  ) {
    return { bytes: Buffer.from(bytes), mediaType: sniffedMediaType };
  }

  const input = Buffer.from(bytes);
  const useHeicDecoder = HEIC_TYPES.has(mediaType);
  try {
    return {
      bytes: await imageToJpeg(
        useHeicDecoder ? await heicToRawInput(input) : sharp(input),
      ),
      mediaType: "image/jpeg",
    };
  } catch {
    if (!useHeicDecoder && isHeicIsoBmff(bytes)) {
      try {
        return {
          bytes: await imageToJpeg(await heicToRawInput(input)),
          mediaType: "image/jpeg",
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function normalizeInboundFile(
  file: FetchFileResult,
  fallbackMediaType?: string,
): Promise<FetchFileResult> {
  const mediaType = file.mediaType ?? fallbackMediaType;
  if (mediaType === undefined || !mediaType.startsWith("image/")) return file;

  try {
    const image = await toProviderSafeImage(file.bytes, mediaType);
    if (image === null) throw new Error("Image decoding failed.");
    if (
      sniffProviderSafeImageType(file.bytes) === image.mediaType &&
      file.bytes.byteLength <= INLINE_IMAGE_LIMIT_BYTES
    ) {
      return { ...file, bytes: image.bytes, mediaType: image.mediaType };
    }
    return {
      bytes: image.bytes,
      mediaType: image.mediaType,
      filename: jpegFilename(file.filename),
    };
  } catch (error) {
    console.warn("[inbound-media:image.unreadable]", {
      mediaType,
      bytes: file.bytes.byteLength,
      error,
    });
    throw new Error(`Unreadable ${mediaType} image attachment.`);
  }
}

async function imageToJpeg(image: ReturnType<typeof sharp>): Promise<Buffer> {
  return image
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82 })
    .toBuffer();
}

async function heicToRawInput(bytes: Buffer) {
  const { width, height, data } = await heicDecode({ buffer: bytes });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  });
}

function sniffProviderSafeImageType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function isHeicIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxLength =
    (bytes[0]! * 0x1000000) +
    (bytes[1]! << 16) +
    (bytes[2]! << 8) +
    bytes[3]!;
  const end = Math.min(bytes.length, boxLength);
  if (["heic", "heif", "mif1"].includes(ascii(bytes, 8, 12))) return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (["heic", "heif", "mif1"].includes(ascii(bytes, offset, offset + 4))) {
      return true;
    }
  }
  return false;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
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
