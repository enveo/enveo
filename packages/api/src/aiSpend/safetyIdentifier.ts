/**
 * Stable, privacy-preserving `safety_identifier` for individual-user operator OpenAI calls
 * (GPT-5.6 guide recommendation; backlog §1 Luna migration scope).
 *
 * The identifier is a domain-separated HMAC-SHA256 over the internal user id, keyed with a
 * DEDICATED deployment secret (`AI_SAFETY_IDENTIFIER_SECRET`):
 *  - the raw user id or email is NEVER sent to OpenAI;
 *  - the auth/session secret is NEVER reused as the HMAC key (assertAiSpendEnv refuses the
 *    boot if the two are equal);
 *  - no secret configured ⇒ the field is simply omitted — deriving from a fallback key would
 *    silently create a second identity namespace the operator cannot rotate independently.
 *
 * Domain separation uses the same versioned-canonical-JSON idiom as the operation lock: the
 * message is the exact JSON encoding of ["enveo-ai-safety-identifier", 1, userId], so a future
 * derivation change is an explicit version bump, never an ambiguity.
 */
import { createHmac } from "node:crypto";
import { env } from "../env";

export function deriveSafetyIdentifier(secret: string, userId: string): string {
  if (!secret) throw new Error("deriveSafetyIdentifier: empty secret");
  if (!userId) throw new Error("deriveSafetyIdentifier: empty userId");
  return createHmac("sha256", secret)
    .update(JSON.stringify(["enveo-ai-safety-identifier", 1, userId]))
    .digest("hex");
}

/** The identifier for this request, or null when unconfigured / no session user (never a raw id). */
export function safetyIdentifierFor(userId: string | undefined): string | null {
  const secret = env.AI_SAFETY_IDENTIFIER_SECRET;
  if (!secret || !userId) return null;
  return deriveSafetyIdentifier(secret, userId);
}
