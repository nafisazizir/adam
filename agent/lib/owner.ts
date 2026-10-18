import type { SessionAuthContext } from "eve/context";
import { defaultNamespace, type MemoryNamespaceContext, type MemoryScopeContext } from "eve/memory";

import type { HomeOwner, HomeTargetRead } from "#lib/home-target.js";

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

export function ownerPrincipal(auth: SessionAuthContext | null): HomeOwner | null {
  if (auth?.principalType !== "user" || !auth.issuer) return null;
  return { issuer: auth.issuer, principalId: auth.principalId };
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

export interface InboundSender {
  readonly id: string;
  readonly isDirect: boolean;
  readonly isIMessage: boolean;
}

export type OwnerRecord =
  | { readonly kind: "recorded"; readonly principalId: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "invalid"; readonly reason: string };

export interface KnownOwner {
  readonly handles: readonly string[];
  readonly record: OwnerRecord;
}

export type SenderAdmission =
  | { readonly admitted: false; readonly reason: string }
  | {
      readonly admitted: true;
      readonly principalId: string;
      readonly claimed: boolean;
      readonly updatesHome: boolean;
    };

// Emails compare ignoring ASCII case; phone numbers ignore the spaces and punctuation people type.
// Nothing looser, since a near-miss would hand a stranger the owner's identity.
function canonicalHandle(handle: string): string {
  const trimmed = handle.trim().replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return trimmed.includes("@") ? trimmed : trimmed.replace(/[\s().-]/gu, "");
}

export function sameHandle(a: string, b: string): boolean {
  return canonicalHandle(a) === canonicalHandle(b);
}

const rejected = (reason: string): SenderAdmission => ({ admitted: false, reason });

const listed = (handles: readonly string[], handle: string) =>
  handles.some((candidate) => sameHandle(candidate, handle));

// Every alias of the owner acts as one principal so `home.owner` and user-scoped grants stay put:
// the recorded one, unless a handle list is set and leaves it out, which makes the list the
// authority and its first handle the principal. With no owner known at all, the first person to
// text directly claims it; a group never does, and only a direct chat moves the home thread.
export function admitSender(sender: InboundSender, owner: KnownOwner): SenderAdmission {
  if (canonicalHandle(sender.id) === "") return rejected("no sender handle");
  if (!sender.isIMessage) return rejected("sent over SMS or RCS");

  const { handles, record } = owner;
  if (record.kind === "invalid") return rejected(`the home pointer is unusable (${record.reason})`);
  if (record.kind === "unconfigured" && handles.length === 0) {
    return rejected("no Blob store and no OWNER_IMESSAGE_HANDLES, so no owner can be known");
  }

  const recorded = record.kind === "recorded" ? record.principalId : undefined;
  const updatesHome = sender.isDirect;
  if (handles.length > 0) {
    if (!listed(handles, sender.id)) return rejected("not the owner");
    const principalId =
      recorded !== undefined && listed(handles, recorded) ? recorded : canonicalHandle(handles[0]!);
    return { admitted: true, principalId, claimed: false, updatesHome };
  }

  if (recorded === undefined) {
    return sender.isDirect
      ? { admitted: true, principalId: sender.id, claimed: true, updatesHome }
      : rejected("a group chat cannot claim ownership");
  }

  if (!sameHandle(recorded, sender.id)) return rejected("not the owner");
  return { admitted: true, principalId: recorded, claimed: false, updatesHome };
}

export function ownerRecordFrom(read: HomeTargetRead, issuer: string): OwnerRecord {
  switch (read.status) {
    case "found":
      return read.home.owner.issuer === issuer
        ? { kind: "recorded", principalId: read.home.owner.principalId }
        : { kind: "invalid", reason: `owner issuer is ${read.home.owner.issuer}` };
    case "absent":
      return { kind: "absent" };
    case "unconfigured":
      return { kind: "unconfigured" };
    case "invalid":
      return { kind: "invalid", reason: read.reason };
  }
}

// Only the owner's own direct messages rewrite the pointer, always under the same principal, so a
// recorded owner is cached for the life of the instance; nothing else is.
export function ownerRecordLookup(read: () => Promise<HomeTargetRead>, issuer: string) {
  let cached: string | undefined;

  return {
    async current(): Promise<OwnerRecord> {
      if (cached !== undefined) return { kind: "recorded", principalId: cached };
      let record: OwnerRecord;
      try {
        record = ownerRecordFrom(await read(), issuer);
      } catch (error) {
        record = { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
      }
      if (record.kind === "recorded") cached = record.principalId;
      return record;
    },
    remember(principalId: string): void {
      cached = principalId;
    },
    // A claim counts only once `persist` lands, so no instance admits an owner others cannot see.
    async claim(principalId: string, persist: () => Promise<void>): Promise<boolean> {
      try {
        await persist();
      } catch {
        return false;
      }
      cached = principalId;
      return true;
    },
  };
}
