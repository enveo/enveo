export const APP_VERSION = "4.8.13";

export const BUILD_INFO = Object.freeze(typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : { time: "", sha: "" });

export function buildLabel(time = BUILD_INFO.time): string {
  if (!time) return "";
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `build ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
