 
export const APP_VERSION = "4.1.4";

 
export const BUILD_INFO: { time: string; sha: string } = typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : { time: "", sha: "" };

 
export function buildLabel(): string {
  const { time, sha } = BUILD_INFO;
  if (!time && !sha) return "";
  return ["build", time, sha ? `· ${sha}` : ""].filter(Boolean).join(" ");
}
