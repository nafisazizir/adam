import { defineTool } from "eve/tools";
import { z } from "zod";

import { blobRoutineStore } from "#lib/routine-store.js";
import { listRoutines, routineView } from "#lib/routines.js";
import { formatUserDateTime } from "#lib/time.js";

export default defineTool({
  description:
    "List the user's routines: each one's id, name, instruction, schedule, next run, whether it is paused, its " +
    "end date, and notes from its last few runs with whether you texted. Use it before changing or deleting " +
    "one, and to run one now when the user asks: follow its instruction in this turn.",
  inputSchema: z.object({}),
  async execute() {
    return { routines: (await listRoutines(blobRoutineStore)).map((routine) => routineView(routine, formatUserDateTime)) };
  },
});
