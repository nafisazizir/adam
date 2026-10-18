import type { SessionAuthContext } from "eve/context";
import { defaultNamespace, type MemoryNamespaceContext, type MemoryScopeContext } from "eve/memory";

import type { HomeOwner } from "#lib/home-target.js";

// User-scoped connections key grants by issuer and principal id, so a background run acting as the
// owner reuses the grant the owner approved in chat instead of failing with `principal_required`.
export function ownerAuth(
  owner: HomeOwner,
  source: Pick<SessionAuthContext, "authenticator" | "attributes">,
): SessionAuthContext {
  return {
    ...source,
    issuer: owner.issuer,
    principalId: owner.principalId,
    principalType: "user",
  };
}

// Leaves out the authenticator that `byPrincipal` keys on: `ownerAuth` keeps each trigger's own
// (photon-imessage, workouts, coding-sessions), which would split the owner into one memory per trigger.
export function ownerMemoryScope(ctx: Pick<MemoryScopeContext, "session">): string[] | string | null {
  const caller = ctx.session.auth.current;
  if (caller?.principalType === "local-dev") return "local-dev";
  if (caller?.principalType !== "user" || !caller.issuer) return null;
  return [caller.issuer, caller.principalId];
}

export interface Deployment {
  readonly onVercel: boolean;
  readonly environment: string | undefined;
}

// Eve's default namespace includes the graph node, so root and each subagent would get their own
// document. Pinning the node to root's keeps the deployment-aware part (production stable across
// deploys, previews per branch) while every agent in the graph reads the same owner document.
// On Vercel without the project or environment in system env, Eve would fall back to a form that a
// preview could share with production, so memory is disabled there instead.
export function ownerMemoryNamespace(ctx: MemoryNamespaceContext, deployment: Deployment): string | null {
  const namespace = defaultNamespace({ ...ctx, node: "__root__" });
  if (!deployment.onVercel) return namespace;
  if (!deployment.environment || !isVercelNamespace(namespace)) {
    console.warn("[owner-memory] Vercel project or environment unknown; memory disabled");
    return null;
  }
  return namespace;
}

function isVercelNamespace(namespace: string): boolean {
  try {
    const parts: unknown = JSON.parse(namespace);
    return Array.isArray(parts) && parts[1] === "vercel";
  } catch {
    return false;
  }
}
