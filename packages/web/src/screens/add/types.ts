import type { EditedImportItem, ImportItem } from "../../lib/api";

export type Tab = "expense" | "income" | "transfer";

/** Draft mode: import item editor — full AddScreen look, but submit does
 *  NOT save a transaction (zero local.*), it only hands an EditedImportItem
 *  back to ImportSheet (corrections go later through /import/apply). */
export interface AddDraft {
  item: ImportItem;
  accountId: string;
  initial?: EditedImportItem;
  onSave: (e: EditedImportItem) => void;
  onCancel: () => void;
}

/** One split row: an envelope plus its integer minor-unit share. */
export interface SplitItem {
  envelopeId: string;
  amount: number;
}
