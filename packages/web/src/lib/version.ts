 
export const APP_VERSION = "4.8.9";

 
export const BUILD_INFO = Object.freeze(typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : { time: "", sha: "" });

 
export function buildLabel(): string {
  return BUILD_INFO.time ? `build ${BUILD_INFO.time}` : "";
}
