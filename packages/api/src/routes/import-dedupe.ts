/** Compatibility names for the API route; the implementation is shared with local E2EE. */
export {
  buildImportDupIndex as buildDupIndex,
  classifyImportDup as classifyDup,
  type ExistingImportRow as ExistingRow,
  type ImportCandidate as DupItem,
  type ImportDupIndex as DupIndex,
  type ImportDupStatus as DupStatus,
} from "@enveo/shared";
