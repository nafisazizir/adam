import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { blobRoutineStore } from "#lib/routine-store.js";
import { removeRoutine } from "#lib/routines.js";

export default defineTool({
  description:
    "Delete a routine by id for good. To stop it for a while, pause it with update_routine instead. Call " +
    "list_routines first to find the id. Only the user, chatting, can delete one.",
  inputSchema: z.object({ id: z.string().min(1).describe("The routine id from list_routines.") }),
  async execute({ id }, ctx) {
    const refusal = ownerChatRefusal("Deleting a routine", ctx.session.auth.current);
    if (refusal) throw new Error(refusal);

    if (!(await removeRoutine(blobRoutineStore, id))) {
      return { id, deleted: false, reason: "There is no routine with that id; it may already be gone." };
    }
    return { id, deleted: true };
  },
});
