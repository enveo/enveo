import type { AiStatus } from "./contracts";

export function importExecution(status: AiStatus): "provider" | "unavailable" {
  return status.capabilities.has("screenshot-import") ? "provider" : "unavailable";
}

export function importFlow(status: AiStatus, tier: "plain" | "e2ee"): "server" | "local-e2ee" | "unavailable" {
  if (importExecution(status) === "unavailable") return "unavailable";
  return tier === "e2ee" ? "local-e2ee" : "server";
}
