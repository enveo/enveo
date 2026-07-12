/** better-auth instance — always on; email+password always enabled. */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { db, sql } from "./db/client";
import * as s from "./db/schema";
import { signupsOpen } from "./authPolicy";
import { env } from "./env";
import type { Executor } from "./sync/apply";

// The session middleware (index.ts) sets `userId` — the global declaration makes
// `c.get("userId")`/`c.set("userId", …)` type-check in EVERY Hono router.
declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
  }
}

/** A user counts as credentialed once they own any auth_accounts row (password or OAuth).
 *  Pre-2.0 databases contain only a credential-less stub owner → firstRun stays true. */
export async function hasCredentialedUser(x: Executor = db): Promise<boolean> {
  const rows = await x.select({ id: s.authAccounts.id }).from(s.authAccounts).limit(1);
  return rows.length > 0;
}

const SIGNUP_GATE_LOCK = 815901; // arbitrary app-wide advisory lock id for the signup gate

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: s.users, session: s.authSessions, account: s.authAccounts, verification: s.authVerifications },
  }),
  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {},
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
  advanced: { database: { generateId: () => crypto.randomUUID() } },
  databaseHooks: {
    user: {
      create: {
        // Registration policy gate — the check must hold under two concurrent
        // first registrations. pg_advisory_xact_lock is transaction-scoped
        // (auto-released on commit/rollback) and runs on ONE reserved
        // connection via sql.begin — a session-scoped lock on the pooled `db`
        // could unlock on a different connection than it locked.
        before: async (user) => {
          await sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(${SIGNUP_GATE_LOCK})`;
            const rows = await tx`select id from auth_accounts limit 1`;
            const open = signupsOpen({
              deployment: env.DEPLOYMENT,
              allowSignups: env.ALLOW_SIGNUPS,
              hasCredentialedUser: rows.length > 0,
            });
            if (!open) throw new APIError("FORBIDDEN", { message: "signups_closed" });
          });
          // Residual race — the lock is released before the auth_accounts row
          // lands — is acceptable: both raced signups were legitimately first-run.
          return { data: user };
        },
      },
    },
  },
});
