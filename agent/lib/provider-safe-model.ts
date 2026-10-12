import { gateway, wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import { toProviderSafeImage } from "./inbound-media.js";

type InlineImageFilePart = {
  type: "file";
  data: { type: "data"; data: Uint8Array | string };
  mediaType: string;
  filename?: string;
};

type TextPart = { type: "text"; text: string };

type ModelPrompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type ModelPromptMessage = ModelPrompt[number];

export const providerSafeModelMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    prompt: await Promise.all(params.prompt.map(transformPromptMessage)),
  }),
};

export function providerSafeModel(modelId: string) {
  return wrapLanguageModel({
    model: gateway(modelId),
    middleware: providerSafeModelMiddleware,
  });
}

async function transformPromptMessage<Message extends ModelPromptMessage>(
  message: Message,
): Promise<Message> {
  if (message.role === "system") return message;
  const content = await Promise.all(
    message.content.map(async (part) => {
      if (
        part.type === "file" &&
        isImageMediaType(part.mediaType) &&
        part.data.type === "data"
      ) {
        return normalizeImagePart({
          ...part,
          data: { type: "data", data: part.data.data },
        });
      }
      if (part.type === "tool-result" && part.output.type === "content") {
        return {
          ...part,
          output: {
            ...part.output,
            value: await Promise.all(
              part.output.value.map(async (output) => {
                if (
                  output.type === "file" &&
                  isImageMediaType(output.mediaType) &&
                  output.data.type === "data"
                ) {
                  return normalizeImagePart({
                    ...output,
                    data: { type: "data", data: output.data.data },
                  });
                }
                return output;
              }),
            ),
          },
        };
      }
      return part;
    }),
  );
  return { ...message, content } as Message;
}

async function normalizeImagePart(
  part: InlineImageFilePart,
): Promise<InlineImageFilePart | TextPart> {
  const bytes =
    typeof part.data.data === "string"
      ? Buffer.from(part.data.data, "base64")
      : part.data.data;
  const image = await toProviderSafeImage(bytes, part.mediaType);
  if (image === null) {
    console.warn("[provider-safe-model:image.unreadable]", {
      filename: part.filename,
      mediaType: part.mediaType,
      bytes: bytes.byteLength,
    });
    return {
      type: "text",
      text: `[Image ${part.filename ?? "attachment"} (${part.mediaType}) could not be read]`,
    };
  }

  return {
    ...part,
    data: { type: "data", data: image.bytes },
    mediaType: image.mediaType,
    ...(image.mediaType === "image/jpeg"
      ? { filename: jpegFilename(part.filename) }
      : {}),
  };
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType === "image" || mediaType.startsWith("image/");
}

function jpegFilename(filename: string | undefined): string {
  const stem = filename?.replace(/\.[^.]*$/, "").trim();
  return `${stem && stem.length > 0 ? stem : "image"}.jpg`;
}
