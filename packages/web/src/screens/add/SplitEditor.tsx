import { useEffect, useState } from "react";
import { AmountPadHost, type AmountPadTarget } from "../../components/AmountPadSheet";
import { Sheet } from "../../components/chrome";
import { CardBox, HighlightedText, PickerSearch, SectionEyebrow } from "../../components/kit";
import type { StateResponse } from "../../lib/api";
import { useCurrency, useMask, useTheme } from "../../lib/contexts";
import { formatMoney } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../../lib/search";
import { font, P, tint } from "../../lib/theme";

export function SplitEditor({
  items,
  setItems,
  envelopes,
  total,
  onCancel,
}: {
  items: Array<{ envelopeId: string; amount: number }>;
  setItems: (i: Array<{ envelopeId: string; amount: number }>) => void;
  envelopes: StateResponse["envelopes"];
  total: number;
  onCancel: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const currency = useCurrency();
  const sum = items.reduce((s, i) => s + i.amount, 0);
  const active = envelopes.filter((e) => !e.archived);
  const envById = new Map(envelopes.map((e) => [e.id, e]));
  // One numpad sheet per split editor — the item supplies the target on tap.
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const openPad = (idx: number) => {
    const it = items[idx]!;
    setPad({
      label: envById.get(it.envelopeId)?.name ?? t("Split across envelopes"),
      initial: it.amount,
      onCommit: (minor) => setItems(items.map((x, i) => (i === idx ? { ...x, amount: minor } : x))),
    });
  };
  // new item: first envelope UNUSED in items + auto-remainder (total − sum)
  const add = () => {
    const used = new Set(items.map((i) => i.envelopeId));
    setItems([...items, { envelopeId: active.find((e) => !used.has(e.id))?.id ?? "", amount: Math.max(0, total - sum) }]);
  };
  // Per-item envelope picker: a compact flat-list bottom sheet (tinted icon + name, no groups/
  // balances) — reopening the full grouped showEnv sheet for every row would be noisy for a split.
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [splitQ, setSplitQ] = useState("");
  useEffect(() => {
    if (pickFor !== null) setSplitQ("");
  }, [pickFor]);
  const matched = sum === total;
  const fillPct = total > 0 ? Math.min(100, Math.max(0, Math.round((sum / total) * 100))) : 0;

  return (
    <div style={{ padding: "4px 0 10px" }}>
      <SectionEyebrow
        label={t("Split across envelopes")}
        right={
          <button
            onClick={onCancel}
            style={{ background: "none", border: "none", color: C.soft, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            {t("cancel split")}
          </button>
        }
      />
      <CardBox style={{ padding: 0 }}>
        {items.map((it, idx) => {
          const e = envById.get(it.envelopeId);
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 14px",
                borderBottom: idx < items.length - 1 ? `1px solid ${C.line}` : "none",
              }}
            >
              <button
                onClick={() => setPickFor(idx)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flex: 1,
                  minWidth: 0,
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: e ? tint(e.color, 0.16) : C.chip,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {e && <Glyph name={e.icon} size={13} color={e.color} sw={1.7} />}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: e ? C.text : C.mute,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e?.name ?? t("Pick an envelope…")}
                </span>
              </button>
              <button
                onClick={() => openPad(idx)}
                style={{
                  background: C.chip,
                  border: "none",
                  borderRadius: 8,
                  padding: "6px 10px",
                  color: C.text,
                  fontSize: 12.5,
                  fontWeight: 650,
                  fontFamily: font,
                  fontVariantNumeric: "tabular-nums",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {formatMoney(it.amount, currency, lang)}
              </button>
              <button
                onClick={() => setItems(items.filter((_, i) => i !== idx))}
                style={{ background: "none", border: "none", color: C.neg, fontSize: 15, cursor: "pointer", padding: "0 0 0 2px", flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          onClick={add}
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 14px",
            background: "none",
            border: "none",
            borderTop: items.length ? `1.3px dashed ${C.line}` : "none",
            color: C.mute,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: font,
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          {t("+ Add item")}
        </button>
      </CardBox>

      <div style={{ padding: `10px ${P}px 0` }}>
        <div style={{ height: 4, borderRadius: 2, background: C.line, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${fillPct}%`, borderRadius: 2, background: matched ? C.pos : C.warn }} />
        </div>
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: matched ? C.pos : C.neg, textAlign: "center" }}>
          {t("Item total: {sum} / {total}", { sum: M(sum), total: M(total) })} {matched ? "✓" : t("(must match)")}
        </div>
      </div>

      <AmountPadHost target={pad} onClose={() => setPad(null)} />

      <Sheet show={pickFor !== null} onClose={() => setPickFor(null)} tall={active.length > SEARCH_THRESHOLD}>
        {(C) => {
          const filtered = active.filter((e) => matchesSearch(e.name, splitQ));
          return (
            <>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 10, textAlign: "center" }}>{t("Choose an envelope")}</div>
                {active.length > SEARCH_THRESHOLD && <PickerSearch value={splitQ} onChange={setSplitQ} />}
              </div>
              <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
                {filtered.length === 0 ? (
                  <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
                ) : (
                  filtered.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        if (pickFor !== null) setItems(items.map((x, i) => (i === pickFor ? { ...x, envelopeId: e.id } : x)));
                        setPickFor(null);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        padding: "8px 0",
                        background: "none",
                        border: "none",
                        borderBottom: `1px solid ${C.line}`,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: tint(e.color, 0.16),
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Glyph name={e.icon} size={14} color={e.color} sw={1.7} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13.5,
                          fontWeight: 550,
                          color: C.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <HighlightedText text={e.name} query={splitQ} />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          );
        }}
      </Sheet>
    </div>
  );
}
