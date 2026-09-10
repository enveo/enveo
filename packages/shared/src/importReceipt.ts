import { z } from "zod";

const money = z.number().int().safe();
const label = z.string();
export const importReceiptSchema = z
  .object({
    completedAt: z.string().datetime({ offset: true }).nullable(),
    currency: z.string().length(3),
    balances: z.array(z.object({ accountId: z.string().min(1), name: label, before: money.nullable(), after: money.nullable() }).strict()).max(1000),
    rows: z
      .array(
        z
          .object({
            rowId: z.string().min(1),
            currency: z.string().length(3).nullable().optional(),
            detailsUnavailable: z.boolean().optional(),
            selected: z.boolean(),
            added: z.boolean(),
            name: label,
            date: z.string().nullable(),
            amount: money.positive().nullable(),
            type: z.enum(["expense", "income", "transfer"]).nullable(),
            isRefund: z.boolean(),
            accountId: z.string().nullable(),
            accountName: label.nullable(),
            toAccountName: label.nullable(),
            envelopeName: label.nullable(),
            categoryName: label.nullable(),
            placeName: label.nullable(),
            note: label.nullable(),
            tag: label,
          })
          .strict(),
      )
      .max(5000),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (new Set(receipt.rows.map((row) => row.rowId)).size !== receipt.rows.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate receipt row" });
    if (
      receipt.rows.some((row) => row.added && (!row.selected || (!row.detailsUnavailable && (row.amount === null || row.type === null || row.date === null))))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "incomplete added row" });
  });
export type ImportReceipt = z.infer<typeof importReceiptSchema>;
export type ImportCompletion = { appliedCount: number; skippedCount: number; receipt?: ImportReceipt };
