import heicDecode from "heic-decode";
import sharp from "sharp";
import { attachmentError, type ChannelDefinition } from "eve/channels";

export type FetchFileResult = Exclude<
  Awaited<ReturnType<NonNullable<ChannelDefinition["fetchFile"]>>>,
  null | Buffer
>;

export interface ProviderSafeImage {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly reencoded: boolean;
}

// Eve sends an image's bytes to the model only within these limits; past them the model gets a
// label it cannot look at.
const INLINE_IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;
const INLINE_IMAGE_MAX_SIDE = 8000;

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
): Promise<ProviderSafeImage | null> {
  const input = Buffer.from(bytes);
  const sniffedMediaType = sniffProviderSafeImageType(bytes);
  if (sniffedMediaType !== undefined && (await inlinesAsIs(input))) {
    return { bytes: input, mediaType: sniffedMediaType, reencoded: false };
  }

  const useHeicDecoder = HEIC_TYPES.has(mediaType);
  try {
    const image = useHeicDecoder ? await heicToRawInput(input) : sharp(input);
    return { bytes: await imageToJpeg(image), mediaType: "image/jpeg", reencoded: true };
  } catch {
    if (useHeicDecoder || !isHeicIsoBmff(bytes)) return null;
    try {
      return {
        bytes: await imageToJpeg(await heicToRawInput(input)),
        mediaType: "image/jpeg",
        reencoded: true,
      };
    } catch {
      return null;
    }
  }
}

// Photon labels a file it has no type for `application/octet-stream`, so the bytes decide.
export function looksLikeImage(bytes: Uint8Array, mediaType: string | undefined): boolean {
  return (
    mediaType?.startsWith("image/") === true ||
    sniffProviderSafeImageType(bytes) !== undefined ||
    isHeicIsoBmff(bytes)
  );
}

export async function normalizeInboundFile(file: FetchFileResult): Promise<FetchFileResult> {
  const mediaType = file.mediaType ?? "application/octet-stream";
  if (!looksLikeImage(file.bytes, file.mediaType)) return file;

  const image = await toProviderSafeImage(file.bytes, mediaType);
  if (image === null) {
    console.warn("[inbound-media:image.unreadable]", {
      mediaType,
      bytes: file.bytes.byteLength,
    });
    throw attachmentError(
      "the image could not be decoded. Ask them to send a screenshot of it instead.",
    );
  }
  return {
    ...file,
    bytes: image.bytes,
    mediaType: image.mediaType,
    ...(image.reencoded ? { filename: jpegFilename(file.filename) } : {}),
  };
}

async function inlinesAsIs(bytes: Buffer): Promise<boolean> {
  if (bytes.byteLength > INLINE_IMAGE_LIMIT_BYTES) return false;
  try {
    const { width = 0, height = 0, orientation = 1 } = await sharp(bytes).metadata();
    return width <= INLINE_IMAGE_MAX_SIDE && height <= INLINE_IMAGE_MAX_SIDE && orientation === 1;
  } catch {
    return false;
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

export function jpegFilename(filename: string | undefined): string {
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
