/**
 * Selfhost password reset — there is no email infrastructure on a self-hosted
 * install, so the operator resets a forgotten password ON THE SERVER (e.g.
 * `docker exec -it enveo-app-1 bun run auth:reset-password …`).
 *
 * Usage: bun run auth:reset-password <email> <new-password>
 *
 * Hashing and the credential-account write go through better-auth's own context
 * (`auth.$context`), so the result is byte-for-byte what a sign-up would have
 * produced (same scrypt config, same `providerId: "credential"` row) and the new
 * password verifies on the normal sign-in route. A user without a credential
 * account yet (Google-only) gets one created — that is how an OAuth user gains a
 * password.
 */
import { and, eq, sql as raw } from "drizzle-orm";
import { auth } from "./auth";
import { db, sql } from "./db/client";
import * as s from "./db/schema";

/** better-auth's provider id for the email+password account row. */
const CREDENTIAL = "credential";

const USAGE = "Usage: bun run auth:reset-password <email> <new-password>";

async function resetPassword(email: string, password: string): Promise<number> {
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength) {
    console.error(`Password too short — minimum ${minPasswordLength} characters.`);
    return 1;
  }
  if (password.length > maxPasswordLength) {
    console.error(`Password too long — maximum ${maxPasswordLength} characters.`);
    return 1;
  }

  // Sign-up stores the email lowercased; match case-insensitively so the operator
  // does not have to reproduce the exact casing.
  const [user] = await db
    .select({ id: s.users.id, email: s.users.email })
    .from(s.users)
    .where(raw`lower(${s.users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  if (!user) {
    console.error(`No user with email ${email}.`);
    return 1;
  }

  const hash = await ctx.password.hash(password);
  const [credential] = await db
    .select({ id: s.authAccounts.id })
    .from(s.authAccounts)
    .where(and(eq(s.authAccounts.userId, user.id), eq(s.authAccounts.providerId, CREDENTIAL)))
    .limit(1);

  if (credential) {
    // Updates the account row(s) with providerId = "credential" for this user.
    await ctx.internalAdapter.updatePassword(user.id, hash);
    console.log(`Password updated for ${user.email}.`);
  } else {
    // Same shape as the sign-up route's linkAccount: accountId = the user's id.
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: CREDENTIAL,
      accountId: user.id,
      password: hash,
    });
    console.log(`Password set for ${user.email} (credential account created).`);
  }
  return 0;
}

const [email, password] = process.argv.slice(2);
let code = 1;
if (!email || !password) {
  console.error(USAGE);
} else {
  code = await resetPassword(email, password).catch((e: unknown) => {
    console.error(`Password reset failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  });
}
await sql.end();
process.exit(code);
