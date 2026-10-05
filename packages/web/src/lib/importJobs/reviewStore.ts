import { type ImportReviewChangesStore, parseImportReviewChanges } from "../importReview";
import { type ImportJobManager, importJobManager } from "./manager";

/** Review changes stay on this device, next to its copy of the budget. */
export function deviceImportReviewStore(manager: Pick<ImportJobManager, "localDraft" | "clearLocalDraft">): ImportReviewChangesStore {
  return {
    load: async (id) => {
      const json = await manager.localDraft(id, "review");
      return json === null ? null : parseImportReviewChanges(json);
    },
    save: async (id, changes) => {
      await manager.localDraft(id, "review", JSON.stringify(changes));
    },
    clear: (id) => manager.clearLocalDraft(id, "review"),
  };
}

export const importReviewStore = deviceImportReviewStore(importJobManager);
