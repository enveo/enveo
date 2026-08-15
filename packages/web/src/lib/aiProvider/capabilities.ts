import type { BudgetSuggestProfile } from "@enveo/shared";
import type { AiStatus } from "./contracts";

export type SuggestionExecution = "local-rules" | "provider" | "unavailable";

export function suggestionExecution(status: AiStatus, profile: BudgetSuggestProfile): SuggestionExecution {
  if (profile === "custom") return status.capabilities.has("custom-prompt") ? "provider" : "unavailable";
  if (status.provider === "rules" || !status.capabilities.has("budget-suggestion")) return "local-rules";
  return "provider";
}

export function importExecution(status: AiStatus): "provider" | "unavailable" {
  return status.capabilities.has("screenshot-import") ? "provider" : "unavailable";
}

export function importFlow(status: AiStatus, tier: "plain" | "e2ee"): "server" | "local-e2ee" | "unavailable" {
  if (importExecution(status) === "unavailable") return "unavailable";
  return tier === "e2ee" ? "local-e2ee" : "server";
}
