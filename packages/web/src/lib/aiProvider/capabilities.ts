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
