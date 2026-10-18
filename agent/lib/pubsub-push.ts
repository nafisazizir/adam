import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const googleCertsUrl = new URL("https://www.googleapis.com/oauth2/v3/certs");
const googleIssuers = ["accounts.google.com", "https://accounts.google.com"];

export interface PushVerifier {
  readonly audience: string;
  readonly serviceAccount: string;
  readonly keys: JWTVerifyGetKey;
}

let googleKeys: JWTVerifyGetKey | undefined;

export function googleSigningKeys(): JWTVerifyGetKey {
  googleKeys ??= createRemoteJWKSet(googleCertsUrl);
  return googleKeys;
}

// A Pub/Sub push with authentication carries a Google-signed OIDC token for the subscription's
// service account, with the audience the subscription was given.
export async function isAuthenticPush(authorization: string | null, verifier: PushVerifier): Promise<boolean> {
  const token = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "")?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, verifier.keys, {
      issuer: googleIssuers,
      audience: verifier.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "email"],
    });
    return (
      payload.email_verified === true &&
      typeof payload.email === "string" &&
      payload.email.toLowerCase() === verifier.serviceAccount.toLowerCase()
    );
  } catch {
    return false;
  }
}

const envelopeSchema = z.object({
  message: z.object({ data: z.string().min(1), messageId: z.string().optional() }),
  subscription: z.string().optional(),
});

const notificationSchema = z.object({
  emailAddress: z.string().min(1),
  historyId: z.union([z.string().regex(/^\d+$/u), z.number().int().nonnegative()]).transform(String),
});

export interface MailboxNotification {
  readonly emailAddress: string;
  readonly historyId: string;
}

export function parseMailboxNotification(body: unknown): MailboxNotification | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return null;
  try {
    const data = JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf8"));
    const notification = notificationSchema.safeParse(data);
    return notification.success ? notification.data : null;
  } catch {
    return null;
  }
}
