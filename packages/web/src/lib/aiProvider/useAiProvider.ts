import { useMemo } from "react";
import { useBudgetPreferences } from "../contexts";
import * as e2ee from "../e2ee";
import { store } from "../store";
import { createAiProvider } from "./factory";

/** The selected provider for the active replica. No credential material is
 * captured here: plain BYOK providers retain only budget/model identifiers. */
export function useAiProvider() {
  const { preferences } = useBudgetPreferences();
  const tier = e2ee.getTierMeta().tier;
  const budgetId = store.getBudgetId() || store.getLedger()?.budgets[0]?.id || "";
  const unlocked = tier === "plain" || e2ee.getDek() !== null;
  return useMemo(() => createAiProvider({ tier, budgetId, unlocked, preferences }), [tier, budgetId, unlocked, preferences]);
}
