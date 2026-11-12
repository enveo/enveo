import { z } from "zod";
import { IMPORT_DUP_STATUSES } from "./importDedupe";
import { IMPORT_RELATION_KINDS, IMPORT_REVIEW_REASONS } from "./importRecognition";

const money = z.number().int().safe();

/** Which reviewed fields the human changed against the recognized row: names only, never values. */
export const IMPORT_CORRECTION_FIELDS = [
  "selection",
  "type",
  "isRefund",
  "amount",
  "currency",
  "date",
  "accountId",
  "toAccountId",
  "envelopeId",
  "categoryId",
  "name",
  "placeName",
  "note",
] as const;
export type ImportCorrectionField = (typeof IMPORT_CORRECTION_FIELDS)[number];
const label = z.string();
const tally = z.number().int().min(0).max(10_000);
/** What the bank-balance check of the review did, without any amount, so whether the balance match
 *  helps is read from receipts. The counts cover the review since it was last opened on this device. */
export const importBalanceCheckSchema = z
  .object({
    /** A bank figure read from the screenshot: none, kept as read, or changed (cleared included). */
    screenshotFigure: z.enum(["none", "kept", "changed"]),
    /** The bank figure against the account after the import: none = no figure to compare. */
    difference: z.enum(["none", "zero", "nonzero"]),
    /** Selected rows still counted at their foreign face value, so the difference is not exact. */
    foreignAtFaceValue: z.boolean(),
    suggested: tally,
    declined: tally,
    unmatched: tally,
    /** Suggestions the human applied, and the row changes they made. */
    applied: tally,
    appliedChanges: tally,
    reconcileAfter: z.boolean(),
  })
  .strict();
export type ImportBalanceCheck = z.infer<typeof importBalanceCheckSchema>;
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
            /** Absent = not measured (older receipt or no recognized baseline); [] = measured, unchanged. */
            correctionFields: z
              .array(z.enum(IMPORT_CORRECTION_FIELDS))
              .max(IMPORT_CORRECTION_FIELDS.length)
              .refine((fields) => new Set(fields).size === fields.length, "duplicate correction field")
              .optional(),
            /** The recognized row's flags, names only, so how often each flag was right is read from
             *  receipts. Absent = not recorded (older receipt or no recognized baseline). */
            reviewReasons: z
              .array(z.enum(IMPORT_REVIEW_REASONS))
              .max(IMPORT_REVIEW_REASONS.length)
              .refine((reasons) => new Set(reasons).size === reasons.length, "duplicate review reason")
              .optional(),
            duplicateStatus: z.enum(IMPORT_DUP_STATUSES).optional(),
            relationKind: z.enum(IMPORT_RELATION_KINDS).nullable().optional(),
          })
          .strict(),
      )
      .max(5000),
    /** Absent = not recorded (older receipt). */
    balanceCheck: importBalanceCheckSchema.optional(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (new Set(receipt.balances.map((balance) => balance.accountId)).size !== receipt.balances.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate receipt balance" });
    if (new Set(receipt.rows.map((row) => row.rowId)).size !== receipt.rows.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate receipt row" });
    if (
      receipt.rows.some((row) => row.added && (!row.selected || (!row.detailsUnavailable && (row.amount === null || row.type === null || row.date === null))))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "incomplete added row" });
  });
export type ImportReceipt = z.infer<typeof importReceiptSchema>;
export type ImportCompletion = { appliedCount: number; skippedCount: number; receipt?: ImportReceipt };
