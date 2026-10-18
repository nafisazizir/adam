import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { ownerMemoryNamespace, ownerMemoryScope } from "#lib/owner.js";

export function ownerMemory() {
  return defineMemory({
    description:
      "Durable facts about the owner that matter in any future session: injuries and health limits, training and food preferences, routines, the people in their life, and standing instructions for how Adam behaves.",
    provider: fileMemory(),
    scope: ownerMemoryScope,
    namespace: ownerMemoryNamespace,
  });
}
