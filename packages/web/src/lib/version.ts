/** The visible app version — bumped MANUALLY by 1 with every change. */
export const APP_VERSION = "2.2.0";

/** Build stamp injected by Vite (define). Changes with every build. */
export const BUILD_INFO: { time: string; sha: string } =
  typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : { time: "", sha: "" };

/** The "build …" line for the UI (empty when no data). */
export function buildLabel(): string {
  const { time, sha } = BUILD_INFO;
  if (!time && !sha) return "";
  return ["build", time, sha ? `· ${sha}` : ""].filter(Boolean).join(" ");
}
