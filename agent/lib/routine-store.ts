import { blobDocumentStore } from "#lib/blob-document.js";
import { env } from "#lib/env.js";
import { routinesDocumentSchema } from "#lib/routines.js";
import { timers } from "#lib/timers.js";

export const blobRoutineStore = blobDocumentStore("routines.json", routinesDocumentSchema);

// Every routine due at one instant shares a timer key, so they arrive as one run.
export function armRoutineRun(at: string): Promise<string> {
  return timers.set({ url: env.routinesRunUrl, body: { at }, fireAtMs: Date.parse(at), key: `routines-${at}` });
}
