import type { EditedImportItem, ImportItem } from "../../lib/api";

export type Tab = "expense" | "income" | "transfer";

/** Draft mode: import item editor — full AddScreen look, but submit does
 *  NOT save a transaction (zero local.*), it only hands an EditedImportItem
 *  back to ImportSheet (corrections go later through the local import batch). */
export interface AddDraft {
  item: ImportItem;
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
