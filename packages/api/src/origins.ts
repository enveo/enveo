/**
 * Origin allowlist — SINGLE source of truth for CORS, the CSRF origin-guard
 * (index.ts) AND better-auth's trustedOrigins (auth.ts).
 *
 * better-auth validates the Origin header of every credentialed browser POST
 * against ITS OWN trusted-origins list, not against the app origin-guard. If
 * the two lists diverge, sign-in/sign-up return 403 INVALID_ORIGIN while the
 * rest of the API keeps working — which locks operators out entirely now that
 * accounts are mandatory.
 */
import { env } from "./env";

type OriginEnv = Pick<typeof env, "ALLOWED_ORIGINS" | "BETTER_AUTH_URL" | "WEB_DIST">;



export function staticAllowedOrigins(e: OriginEnv = env): Set<string> {
  return new Set<string>([
    ...e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    ...(e.BETTER_AUTH_URL ? [new URL(e.BETTER_AUTH_URL).origin] : []),
    ...(e.WEB_DIST ? [] : ["http://localhost:5173"]),  
  ]);
}






export function isSameHostOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}






export function authTrustedOrigins(request?: Request): string[] {
  const trusted = [...staticAllowedOrigins()];
  const origin = request?.headers.get("origin");
  if (origin && isSameHostOrigin(origin, request?.headers.get("host"))) trusted.push(origin);
  return trusted;
}
