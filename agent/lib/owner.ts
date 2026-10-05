import type { SessionAuthContext } from "eve/context";

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
