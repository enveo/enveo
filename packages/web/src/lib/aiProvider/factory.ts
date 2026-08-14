import type { BudgetPreferences } from "@enveo/shared";
import type { AiProvider } from "./contracts";
import { createE2eeByokProvider } from "./e2eeByok";
import { createEnveoAiProvider } from "./enveo";
import { createPlainByokProvider } from "./plainByok";
import { RulesProvider } from "./rules";

export interface AiProviderFactoryInput {
  tier: "plain" | "e2ee";
  budgetId: string;
  unlocked: boolean;
  preferences: BudgetPreferences;
}

export function createAiProvider(input: AiProviderFactoryInput): AiProvider {
  if (input.preferences.aiProvider === "rules") return new RulesProvider();
  if (input.preferences.aiProvider === "enveo") return createEnveoAiProvider(input.tier);
  return input.tier === "e2ee"
    ? createE2eeByokProvider(input.budgetId, input.preferences.openaiModel, input.unlocked)
    : createPlainByokProvider(input.tier, input.budgetId, input.preferences.openaiModel);
}
