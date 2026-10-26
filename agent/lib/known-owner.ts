import { photonAuthenticator } from "#channels/photon.js";
import { env } from "#lib/env.js";
import { readHomeTargetState } from "#lib/home-target.js";
import { type KnownOwner, ownerRecordLookup } from "#lib/owner.js";

const ownerRecord = ownerRecordLookup(readHomeTargetState, photonAuthenticator);

// The same owner the chat channels admit, so a number that can no longer text can't call either.
export async function knownOwner(): Promise<KnownOwner> {
  return { handles: env.OWNER_IMESSAGE_HANDLES, record: await ownerRecord.current() };
}
