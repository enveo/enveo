export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://enveo:enveo@localhost:5432/enveo",
  PORT: Number(process.env.PORT ?? 8080),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-5.5",
  // directory with the built frontend (served in production)
  WEB_DIST: process.env.WEB_DIST ?? "",
  // CSV of app origins allowed for cross-origin mutations (CORS + origin-guard)
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "",
  DEPLOYMENT: (process.env.DEPLOYMENT === "cloud" ? "cloud" : "selfhost") as "selfhost" | "cloud",
  ALLOW_SIGNUPS: process.env.ALLOW_SIGNUPS ?? "",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8080",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
};

/** Fail fast on boot: accounts are mandatory, so the session secret is too. */
export function assertAuthEnv(): void {
  if (env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET is required (min 32 chars). Generate one with: openssl rand -hex 32",
    );
  }
}
