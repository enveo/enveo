import type { EditedImportItem } from "../../lib/api";
import type { ImportReviewDraftItem } from "../../lib/importReview";

export type Tab = "expense" | "income" | "transfer";

/** Draft mode: import item editor — full AddScreen look, but submit does
 *  NOT save a transaction (zero local.*), it only hands an EditedImportItem
 *  back to ImportSheet (corrections go later through the local import batch). */
export interface AddDraft {
  item: ImportReviewDraftItem;
  accountId: string;
  initial?: EditedImportItem;

  automaticEnvelopeDefault?: boolean;
  onSave: (e: EditedImportItem, meta: { automaticEnvelopeDefault: boolean }) => void;
  onCancel: () => void;
}

export interface SplitItem {
  envelopeId: string;
  amount: number;
}
