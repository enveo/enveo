/**
 * DATABASE_URL resolution, in priority order:
 *  1. DATABASE_URL — the canonical form (compose, Railway, the docs),
 *  2. DB_HOST + optional DB_PORT/DB_USER/DB_PASS/DB_NAME — managed hosts that
 *     inject discrete connection parts (PikaPods' shared Postgres does exactly
 *     this); credentials are URL-escaped, DB_NAME falls back to DB_USER,
 *  3. localhost dev fallback — DEV ONLY. In production a missing database
 *     config must stop the boot (assertDbEnv): the silent fallback once aimed
 *     the test suite at a production port.
 */
export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.DB_HOST) {
    const user = encodeURIComponent(process.env.DB_USER ?? "enveo");
    const pass = process.env.DB_PASS ? `:${encodeURIComponent(process.env.DB_PASS)}` : "";
    const port = process.env.DB_PORT ?? "5432";
    const name = process.env.DB_NAME ?? process.env.DB_USER ?? "enveo";
    return `postgres://${user}${pass}@${process.env.DB_HOST}:${port}/${name}`;
  }
  return "postgres://enveo:enveo@localhost:5432/enveo";
}

 
export function assertDbEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.DATABASE_URL || process.env.DB_HOST) return;
  throw new Error("DATABASE_URL is required in production (or DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME for hosts that inject discrete parts).");
}

export const env = {
  DATABASE_URL: resolveDatabaseUrl(),
  PORT: Number(process.env.PORT ?? 8080),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
   
  WEB_DIST: process.env.WEB_DIST ?? "",
   
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "",
  DEPLOYMENT: (process.env.DEPLOYMENT === "cloud" ? "cloud" : "selfhost") as "selfhost" | "cloud",
  ALLOW_SIGNUPS: process.env.ALLOW_SIGNUPS ?? "",
  /** DEDICATED secret for the privacy-preserving `safety_identifier` on operator OpenAI calls
   *  (domain-separated HMAC over the user id — aiSpend/safetyIdentifier.ts). Optional: absent ⇒
   *  the field is omitted. MUST NOT reuse BETTER_AUTH_SECRET (assertAiSpendEnv fails the boot). */
  AI_SAFETY_IDENTIFIER_SECRET: process.env.AI_SAFETY_IDENTIFIER_SECRET ?? "",
   
  AI_VAULT_KEY_RING_FILE: process.env.AI_VAULT_KEY_RING_FILE ?? "",
   
  ENVEO_DEV_AI_VAULT_KEY_RING_JSON: process.env.ENVEO_DEV_AI_VAULT_KEY_RING_JSON ?? "",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8080",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
};

/** Destructive demo seeding requires a deliberately named development database and explicit intent. */
export function assertSeedEnv(databaseUrl = env.DATABASE_URL): void {
  let developmentDatabase = false;
  try {
    const url = new URL(databaseUrl);
    developmentDatabase =
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      !!url.hostname &&
      /^[A-Za-z0-9_]+_dev$/.test(decodeURIComponent(url.pathname.slice(1))) &&
      !url.search &&
      !url.hash;
  } catch {
     
  }
  if (process.env.NODE_ENV !== "development" || process.env.ENVEO_SEED_ACK !== "throwaway" || !developmentDatabase) {
    throw new Error("db:seed requires NODE_ENV=development, ENVEO_SEED_ACK=throwaway and an explicit *_dev PostgreSQL database without URL options.");
  }
}

 
export function assertAuthEnv(): void {
  if (env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET is required (min 32 chars). Generate one with: openssl rand -hex 32");
  }
}
