import type { ImportReceipt } from "@enveo/shared";
import { useMask, useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";

export function ImportCompletionDetails({ receipt }: { receipt: ImportReceipt | null }) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  if (!receipt) return <p style={{ color: C.soft }}>{t("Details were not saved for this import.")}</p>;
  const money = (value: number | null, currency = receipt.currency) => (value === null ? "—" : M(value, currency));
  const rows = (added: boolean) =>
    receipt.rows
      .filter((row) => row.added === added)
      .map((row) =>
        row.detailsUnavailable ? (
          <li key={row.rowId} style={{ marginBottom: 12 }}>
            {t("Added")} · {t("Historical details are unavailable for this transaction.")}
          </li>
        ) : (
          <li key={row.rowId} style={{ padding: "12px 0", borderBottom: `1px solid ${C.line}`, listStyle: "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <strong>{row.name || t("Transaction")}</strong>
              <strong style={{ whiteSpace: "nowrap" }}>{money(row.amount, row.currency ?? receipt.currency)}</strong>
            </div>
            <div style={{ color: C.soft, fontSize: 12, marginTop: 4 }}>
              {row.date} · {added ? t("Added") : t("Skipped")}
              {!added && row.selected ? ` · ${t("Selected in review")}` : ""}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {[
                row.type === "transfer"
                  ? t("Transfer")
                  : row.type === "income"
                    ? t("Income")
                    : row.type === "expense"
                      ? row.isRefund
                        ? t("Refund")
                        : t("Expense")
                      : null,
                row.accountName,
                row.toAccountName ? `→ ${row.toAccountName}` : null,
                row.envelopeName,
                row.categoryName,
                row.placeName,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {row.note && <div style={{ fontSize: 12, marginTop: 4 }}>{row.note}</div>}
            {row.tag && <div style={{ fontSize: 12, color: C.soft }}>{row.tag}</div>}
          </li>
        ),
      );
  return (
    <div data-import-completion-details style={{ textAlign: "left", color: C.text, marginTop: 20 }}>
      {receipt.completedAt && (
        <p style={{ color: C.soft, fontSize: 12 }}>
          {new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(receipt.completedAt))}
        </p>
      )}
      {receipt.balances.map((account) => (
        <section key={account.accountId} style={{ background: C.bg, borderRadius: 12, padding: 12, marginBottom: 10 }}>
          <strong>{account.name}</strong>
          <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, fontSize: 13, marginBottom: 0 }}>
            <dt>{t("Balance before import")}</dt>
            <dd style={{ margin: 0 }}>{money(account.before)}</dd>
            <dt>{t("Balance change")}</dt>
            <dd style={{ margin: 0 }}>{money(account.before === null || account.after === null ? null : account.after - account.before)}</dd>
            <dt>{t("Balance after import")}</dt>
            <dd style={{ margin: 0, fontWeight: 700 }}>{money(account.after)}</dd>
          </dl>
        </section>
      ))}
      <p style={{ color: C.soft, fontSize: 12 }}>{t("Balances saved when this import was completed. Later transaction changes do not update this summary.")}</p>
      <h3 style={{ fontSize: 14 }}>{t("Added")}</h3>
      <ul style={{ padding: 0, margin: 0 }}>{rows(true)}</ul>
      {receipt.rows.some((row) => !row.added) && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{t("Skipped: {n}", { n: receipt.rows.filter((row) => !row.added).length })}</summary>
          <ul style={{ padding: 0, margin: 0 }}>{rows(false)}</ul>
        </details>
      )}
    </div>
  );
}
