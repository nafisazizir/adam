import {
  ConnectionAuthorizationFailedError,
  type ConnectionAuthProvider,
  type InteractiveAuthorizationDefinition,
  isConnectionAuthorizationRequiredError,
} from "eve/connections";
import type { SessionAuthContext } from "eve/context";

import { isOwnerChat, isOwnerDirectChat } from "#lib/delivery.js";

interface CallerContext {
  readonly session: { readonly auth: { readonly current: SessionAuthContext | null } };
}

// Eve parks a turn on a sign-in only for an interactive provider, and only that turn's own caller
// can steer it away, so a sign-in opened by a background turn would hold the owner's thread. Every
// other turn gets the same grant without the sign-in: a stored token still works, a missing one
// fails the call so the model can say so.
export function signInFromOwnerDirectChat(
  service: string,
  provider: InteractiveAuthorizationDefinition,
): (ctx: CallerContext) => ConnectionAuthProvider {
  const { startAuthorization, completeAuthorization, principalType, getToken, ...rest } = provider;
  const withoutSignIn: ConnectionAuthProvider = {
    ...rest,
    credentialOwner: "user",
    async getToken(args) {
      try {
        return await getToken(args);
      } catch (error) {
        if (!isConnectionAuthorizationRequiredError(error)) throw error;
        throw new ConnectionAuthorizationFailedError(error.connectionName, {
          message:
            `${service} needs the user to sign in, and a sign-in link only goes out when they ask ` +
            "in a direct chat with you. Tell them that instead of retrying.",
          reason: "sign_in_needs_direct_chat",
          retryable: false,
        });
      }
    },
  };
  return (ctx) => (isOwnerDirectChat(ctx.session.auth.current) ? provider : withoutSignIn);
}

// For tools that hand out such a link themselves (a consent url) rather than through a connection.
export function ownerLinkRefusal(service: string, auth: SessionAuthContext | null): string | null {
  if (isOwnerDirectChat(auth)) return null;
  if (isOwnerChat(auth)) {
    return `A ${service} link only goes out in a direct chat, since anyone here could open it first. Tell the user: text me directly and ask again.`;
  }
  return `A ${service} link only goes out when the user asks for it in a direct chat with you, and this turn did not come from them. Offer it in chat instead.`;
}
