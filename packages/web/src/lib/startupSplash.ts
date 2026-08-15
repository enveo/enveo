import type { BootStatus } from "./store";

export type StartupPresentation = "splash" | "app";

export function startupPresentation(status: BootStatus): StartupPresentation {
  return status === "booting" ? "splash" : "app";
}
