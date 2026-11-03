import { defineTool } from "eve/tools";
import { z } from "zod";

import { isOwnerChat } from "#lib/delivery.js";
import { blobRoutineStore } from "#lib/routine-store.js";
import { isRoutineTurn, recordRoutineRun } from "#lib/routines.js";

export default defineTool({
  description:
    "Record what one run of a routine found, so its next run can compare and not repeat itself after this chat " +
    "has been summarised. Call it once per routine on every routine turn, and after running one now on the " +
    "user's request.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id."),
    note: z
      .string()
      .min(1)
      .max(300)
      .describe("One line the next run needs: the numbers, the decision or the state you found, e.g. 'goal sub-50 10k by Dec; proposed cutting volume 10%'."),
    notified: z.boolean().describe("Whether you are texting the user about this run."),
  }),
  async execute({ id, note, notified }, ctx) {
    const auth = ctx.session.auth.current;
    if (!isRoutineTurn(auth) && !isOwnerChat(auth)) {
      throw new Error("Only a routine turn or the user's chat records a routine run.");
    }
    const recorded = await recordRoutineRun(blobRoutineStore, id, { at: new Date().toISOString(), note, notified });
    return recorded ? { id, recorded: true } : { id, recorded: false, reason: "That routine no longer exists." };
  },
});
