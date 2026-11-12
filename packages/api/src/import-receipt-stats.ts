import { importReceiptSchema } from "@enveo/shared";
import { and, eq, sql as raw } from "drizzle-orm";
import { db, sql } from "./db/client";
import * as s from "./db/schema";
import { summarizeImportReceipts } from "./importJobs/receiptStats";

// Prints counts only, never a receipt's names or amounts. Receipts live as long as their job
// (7 days), so a reading covers the imports completed in that window. An E2EE budget's receipt
// is ciphertext the server cannot read, so only plain budgets are counted.
const rows = await db
  .select({ receipt: raw<unknown>`${s.importJobs.result}->'receipt'` })
  .from(s.importJobs)
  .where(and(eq(s.importJobs.status, "completed"), eq(s.importJobs.tier, "plain"), raw`${s.importJobs.result} ? 'receipt'`));
const receipts = rows.flatMap((row) => {
  const parsed = importReceiptSchema.safeParse(row.receipt);
  return parsed.success ? [parsed.data] : [];
});
const completed = receipts.flatMap((receipt) => (receipt.completedAt ? [receipt.completedAt] : [])).sort();
console.log(
  JSON.stringify(
    { window: { from: completed[0] ?? null, to: completed.at(-1) ?? null }, unreadable: rows.length - receipts.length, ...summarizeImportReceipts(receipts) },
    null,
    2,
  ),
);
await sql.end();
