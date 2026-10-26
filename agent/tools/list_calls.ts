import { defineTool } from "eve/tools";
import { z } from "zod";

import { blobCallTranscriptStore } from "#lib/call-transcript-store.js";
import { recentCalls, type SavedCall } from "#lib/call-transcripts.js";
import { formatUserDateTime } from "#lib/time.js";

export default defineTool({
  description:
    "List the user's most recent phone calls with you that have a saved transcript, newest first, " +
    "each with its conversation id and when it ended in the user's local time. Use it to find the " +
    "id for read_call_transcript when this thread no longer has it.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(30).optional().describe("How many calls, 10 if left out."),
  }),
  label: { start: () => "List recent calls" },
  async execute({ limit }) {
    let saved: SavedCall[];
    try {
      saved = await blobCallTranscriptStore.list();
    } catch (error) {
      console.warn("[call-transcripts] could not list saved calls", error);
      return { unavailable: true, reason: "I couldn't list saved calls right now." };
    }

    return {
      calls: recentCalls(saved, limit ?? 10).map((call) => ({
        conversation: call.conversationId,
        endedAt: formatUserDateTime(call.savedAt),
      })),
    };
  },
});
