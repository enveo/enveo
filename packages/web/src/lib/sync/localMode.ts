










import type { LocalMode } from "./contracts";

const LOCAL_MODE_KEY = "enveo.localMode";
const LEGACY_LOCAL_KEY = "enveo.localOnly";

function readLocalMode(): LocalMode {
  try {
    const v = localStorage.getItem(LOCAL_MODE_KEY);
    if (v === "off" || v === "paused" || v === "wiped") return v;
    if (localStorage.getItem(LEGACY_LOCAL_KEY) === "true") {
       
      try {
        localStorage.setItem(LOCAL_MODE_KEY, "paused");
        localStorage.removeItem(LEGACY_LOCAL_KEY);
      } catch {
         
      }
      return "paused";
    }
  } catch {
     
  }
  return "off";
}

let localMode: LocalMode = readLocalMode();

 
export function getLocalMode(): LocalMode {
  return localMode;
}

 
export function isLocalOnly(): boolean {
  return localMode !== "off";
}






export function setLocalModeValue(mode: LocalMode): void {
  localMode = mode;
}

 
export function writeLocalModeToStorage(mode: LocalMode): void {
  try {
    localStorage.setItem(LOCAL_MODE_KEY, mode);
  } catch {
     
  }
}
