 
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { signupsOpen } from "./authPolicy";
import { db, sql } from "./db/client";
import * as s from "./db/schema";
import { env } from "./env";
import { authTrustedOrigins } from "./origins";
import type { Executor } from "./sync/apply";



declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
  }
}



export async function hasCredentialedUser(x: Executor = db): Promise<boolean> {
  const rows = await x.select({ id: s.authAccounts.id }).from(s.authAccounts).limit(1);
  return rows.length > 0;
}

const SIGNUP_GATE_LOCK = 815901; // arbitrary app-wide advisory lock id for the signup gate

 
export const SIGNUP_CLAIM = "enveo:signup-claim";
const SIGNUP_CLAIM_TTL_SECONDS = 60;

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  




  trustedOrigins: (request) => authTrustedOrigins(request),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: s.users, session: s.authSessions, account: s.authAccounts, verification: s.authVerifications },
  }),
  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {},
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
  advanced: {
    database: { generateId: () => crypto.randomUUID() },
    


    disableOriginCheck: false,
  },
  databaseHooks: {
    user: {
      create: {
        // Registration policy gate. It must hold under two concurrent first
        // registrations (binding spec §1): pg_advisory_xact_lock alone is not
        // enough, because it is released when this transaction commits —
        // BEFORE better-auth inserts the users/auth_accounts rows — so two
        // overlapping first sign-ups would both read zero accounts and both
        // pass. Therefore the winner also COMMITS a short-lived "claim" row
        // (auth_verifications, identifier SIGNUP_CLAIM) inside the locked
        // transaction, and the gate counts live claims as a credentialed
        // user: the serialized loser sees the claim and gets signups_closed.
        // Claims expire after SIGNUP_CLAIM_TTL_SECONDS so an aborted signup
        // (crash between hook and account insert) cannot lock a fresh
        // install out of first-run for good — worst case, retry after 60 s.
        //
        // pg_advisory_xact_lock is transaction-scoped (auto-released on
        // commit/rollback) and runs on ONE reserved connection via sql.begin —
        // a session-scoped lock on the pooled `db` could unlock on a
        // different connection than it locked.
        before: async (user) => {
          await sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(${SIGNUP_GATE_LOCK})`;
            const accounts = await tx`select id from auth_accounts limit 1`;
            await tx`delete from auth_verifications
                     where identifier = ${SIGNUP_CLAIM} and expires_at < now()`;
            const claims = await tx`select id from auth_verifications
                                    where identifier = ${SIGNUP_CLAIM} limit 1`;
            const open = signupsOpen({
              deployment: env.DEPLOYMENT,
              allowSignups: env.ALLOW_SIGNUPS,
              hasCredentialedUser: accounts.length > 0 || claims.length > 0,
            });
            if (!open) throw new APIError("FORBIDDEN", { message: "signups_closed" });
            if (accounts.length === 0) {
              


              await tx`insert into auth_verifications
                         (id, identifier, value, expires_at, created_at, updated_at)
                       values (${crypto.randomUUID()}, ${SIGNUP_CLAIM}, ${user.email ?? ""},
                               now() + make_interval(secs => ${SIGNUP_CLAIM_TTL_SECONDS}),
                               now(), now())`;
            }
          });
          return { data: user };
        },
      },
    },
  },
});
