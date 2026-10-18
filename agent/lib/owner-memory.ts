import type { SessionAuthContext } from "eve/context";
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { deliveryChannelForAuth } from "#lib/delivery.js";
import { env } from "#lib/env.js";
import { guardedMemory } from "#lib/memory.js";
import { ownerMemoryNamespace, ownerMemoryScope } from "#lib/owner.js";

// Background turns (workout debriefs, coding updates) carry text the owner did not write, so only
// the owner's own chat turns, the same gate merge_pull_request uses, get the tools that write memory.
function isOwnerChat(auth: SessionAuthContext | null): boolean {
  if (auth?.principalType === "local-dev") return true;
  return auth !== null && deliveryChannelForAuth(auth) !== null;
}

export function ownerMemory() {
  return defineMemory({
    description:
      "Durable facts about the owner that matter in any future session: injuries and health limits, training and food preferences, routines, the people in their life, and standing instructions for how Adam behaves.",
    provider: guardedMemory(fileMemory(), { label: "owner-memory", canWrite: isOwnerChat }),
    scope: ownerMemoryScope,
    namespace: (ctx) => ownerMemoryNamespace(ctx, env.deployment),
  });
}
