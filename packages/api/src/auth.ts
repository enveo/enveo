/** better-auth instance — created ONLY in AUTH_MODE=multi. */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/client";
import { env } from "./env";
import * as s from "./db/schema";

// The session middleware (index.ts) sets `userId` — the global declaration makes
// `c.get("userId")`/`c.set("userId", …)` type-check in EVERY Hono router.
declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
  }
}

export const auth =
  env.AUTH_MODE === "multi"
    ? betterAuth({
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
        emailAndPassword: { enabled: env.DEV_LOGIN === "1" }, // dev login for tests/e2e — never in prod
        session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
        advanced: { database: { generateId: () => crypto.randomUUID() } },
      })
    : null;
