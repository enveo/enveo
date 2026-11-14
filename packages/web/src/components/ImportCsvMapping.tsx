import { type CsvDateOrder, type CsvMapping, type CsvRow, type CsvTable, csvUsesSeparateColumns, readCsvRows, suggestCsvMapping } from "@enveo/shared";
import { useMemo, useState } from "react";
import { useMask, useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { font, TEAL } from "../lib/theme";

type ColumnField = Exclude<keyof CsvMapping, "dateOrder">;

const PREVIEW_ROWS = 4;

export function ImportCsvMapping({
  table,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  table: CsvTable;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: (rows: CsvRow[]) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();
  const [mapping, setMapping] = useState(() => suggestCsvMapping(table));
  const [separateColumns, setSeparateColumns] = useState(() => csvUsesSeparateColumns(mapping));
  const reading = useMemo(
    () => readCsvRows(table, separateColumns ? { ...mapping, amount: null } : { ...mapping, moneyOut: null, moneyIn: null }),
    [table, mapping, separateColumns],
  );

  const control = {
    width: "100%",
    padding: "9px 10px",
    borderRadius: 10,
    border: `1px solid ${C.line}`,
    background: C.bg,
    color: C.text,
    fontSize: 13,
    fontFamily: font,
  };
  const label = { fontSize: 11.5, fontWeight: 600, color: C.soft, marginBottom: 4 };
  const column = (field: ColumnField, name: string, optional = false) => (
    <label style={{ display: "block", minWidth: 0 }}>
      <div style={label}>{name}</div>
      <select
        aria-label={name}
        style={control}
        value={mapping[field] ?? ""}
        onChange={(event) => setMapping({ ...mapping, [field]: event.target.value === "" ? null : Number(event.target.value) })}
      >
        <option value="">{optional ? t("None") : t("Choose a column")}</option>
        {table.headers.map((header, index) => (
          <option key={index} value={index}>
            {header || `#${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  const canContinue = reading.rows.length > 0 && !busy;
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Match the columns")}</div>
      <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 16 }}>
        {t("Check what each column holds. The preview follows your choices.")}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        {column("date", t("Date"))}
        <label style={{ display: "block", minWidth: 0 }}>
          <div style={label}>{t("Date order")}</div>
          <select
            aria-label={t("Date order")}
            style={control}
            value={mapping.dateOrder}
            onChange={(event) => setMapping({ ...mapping, dateOrder: event.target.value as CsvDateOrder })}
          >
            <option value="dmy">{t("Day first (31.12.2026)")}</option>
            <option value="mdy">{t("Month first (12/31/2026)")}</option>
            <option value="ymd">{t("Year first (2026-12-31)")}</option>
          </select>
        </label>
        {column("payee", t("Payee"), true)}
        {column("description", t("Description"), true)}
        {separateColumns ? (
          <>
            {column("moneyOut", t("Money out"))}
            {column("moneyIn", t("Money in"))}
          </>
        ) : (
          column("amount", t("Amount"))
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.soft, marginBottom: 14 }}>
        <input type="checkbox" checked={separateColumns} onChange={(event) => setSeparateColumns(event.target.checked)} />
        {t("Money in and out are in separate columns")}
      </label>

      <div style={{ borderTop: `1px solid ${C.line}`, marginBottom: 10 }}>
        {reading.rows.slice(0, PREVIEW_ROWS).map((row) => (
          <div key={row.index} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.line}`, fontSize: 12.5, color: C.text }}>
            <span style={{ color: C.soft, whiteSpace: "nowrap" }}>{row.date}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name || "—"}</span>
            <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: row.amount > 0 ? C.pos : C.text }}>{M(row.amount)}</span>
          </div>
        ))}
      </div>
      {reading.unreadable > 0 && (
        <div role="note" style={{ fontSize: 12.5, color: C.warn, marginBottom: 10 }}>
          {tp(
            "{n} row has no readable date or amount and will be left out. | {n} rows have no readable date or amount and will be left out.",
            reading.unreadable,
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12.5, color: C.neg, marginBottom: 10 }}>{error}</div>}

      <button
        disabled={!canContinue}
        onClick={() => onConfirm(reading.rows)}
        style={{
          width: "100%",
          padding: "13px 0",
          borderRadius: 12,
          border: "none",
          background: TEAL,
          color: "#fff",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
          opacity: canContinue ? 1 : 0.5,
          marginBottom: 8,
        }}
      >
        {tp("Review {n} transaction | Review {n} transactions", reading.rows.length)}
      </button>
      <button
        onClick={onBack}
        disabled={busy}
        style={{
          width: "100%",
          padding: "11px 0",
          borderRadius: 12,
          border: `1px solid ${C.line}`,
          background: "transparent",
          color: C.text,
          fontSize: 13.5,
          fontWeight: 600,
        }}
      >
        {t("Back")}
      </button>
    </>
  );
}
