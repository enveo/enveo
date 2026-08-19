import type { ReactNode } from "react";
import type { StateResponse } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Glyph, Ico } from "../../lib/icons";
import { font, P, tint } from "../../lib/theme";

/** One end of the money flow: the source account, or the target envelope/account. */
export interface FlowEndpoint {
  /** Tracked eyebrow above the name — "FROM ACCOUNT" / "TO ACCOUNT" / "ENVELOPE". */
  role: string;
  name: string;
  /** Entity color: tints the icon tile and (envelopes) the "after" pill. */
  color: string;
  icon: string;
  /** Balance/available BEFORE this transaction — struck through once an amount exists. */
  before: number;
  after: number;
  afterColor: string;
  /** Caption under the pill; shown only while an amount is typed. */
  hint: string;
  /** Pill fill behind the "after" amount (accounts use the accent wash, envelopes their own color). */
  pillTint: string;
  /** Absent = a fixed row (no picker behind it). */
  onOpen?: () => void;
  /** Nothing chosen yet — the name renders muted. */
  placeholder?: boolean;
}

export interface SplitPanel {
  label: string;
  items: Array<{ envelopeId: string; amount: number }>;
  envelopes: StateResponse["envelopes"];
  /** The typed amount the items must add up to. */
  total: number;
  /** Refund: items give money BACK to their envelopes. */
  plus: boolean;
  /** Which row the numpad is currently editing. */
  activeIndex: number | null;
  onFocusItem: (index: number) => void;
  onRemoveItem: (index: number) => void;
  onAddItem: () => void;
  onAssignRest: () => void;
}

const EYEBROW = { display: "block", fontSize: 9, fontWeight: 750, letterSpacing: "1.2px", textTransform: "uppercase" } as const;

/**
 * The flow card: WHERE the money comes from, HOW MUCH moves, and WHERE it lands —
 * with each side's balance before/after. Account, envelope/destination, split and
 * date all live here (design B2), so the sections below stay descriptive metadata.
 * Presentational: every number is computed by the controller.
 */
export function FlowCard({
  source,
  target,
  pool,
  note,
  split,
  automatic,
  amountMinor,
  plus,
  dateLabel,
  dateHint,
  onOpenDate,
  splitAction,
}: {
  source: FlowEndpoint;
  /** Expense: the envelope. Transfer: the destination account. Income/split: none. */
  target: FlowEndpoint | null;
  /** Income only: the fixed "goes to Ready to assign" row. */
  pool: { role: string; title: string; caption: string } | null;
  /** Quiet line under the target row (e.g. the automatic-envelope provenance note). */
  note: string | null;
  split: SplitPanel | null;
  /** The account-linked envelope leg of a transfer: what it will do, and a switch to skip it. */
  automatic: { label: string; checked: boolean; onToggle: (checked: boolean) => void; body: ReactNode } | null;
  amountMinor: number;
  plus: boolean;
  dateLabel: string;
  dateHint: string;
  onOpenDate: () => void;
  /** "Split across envelopes ›" / "Cancel split" — hidden in draft mode. */
  splitAction: { label: string; onClick: () => void } | null;
}) {
  const C = useTheme();
  const M = useMask();
  return (
    <div
      style={{
        flex: "0 0 auto",
        margin: `6px ${P}px 0`,
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        padding: 6,
        boxShadow: "0 1px 3px rgba(20,20,28,0.06)",
      }}
    >
      <EndpointRow endpoint={source} showEffect={amountMinor > 0} />

      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 8px 2px 22px" }}>
        <span style={{ width: 2, height: 26, background: C.line, display: "block", flexShrink: 0 }} />
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 750,
            whiteSpace: "nowrap",
            color: plus ? C.pos : C.neg,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {plus ? "+ " : "− "}
          {M(amountMinor)}
        </span>
      </div>

      {split ? <SplitPanelBody split={split} /> : null}
      {target && <EndpointRow endpoint={target} showEffect={amountMinor > 0 && !target.placeholder} />}
      {pool && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px" }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: C.chip,
            }}
          >
            <Glyph name="envelope" size={16} color={C.mute} sw={1.8} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ ...EYEBROW, color: C.mute }}>{pool.role}</span>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: C.text }}>{pool.title}</span>
            <span style={{ display: "block", fontSize: 10.5, color: C.soft }}>{pool.caption}</span>
          </span>
        </div>
      )}
      {note && <div style={{ padding: "0 8px 4px 48px", fontSize: 10.5, color: C.mute }}>{note}</div>}

      {automatic && (
        <div style={{ borderTop: `1px solid ${C.line}`, margin: "4px 8px 0", padding: "8px 0 2px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={automatic.checked}
              onChange={(e) => automatic.onToggle(e.target.checked)}
              style={{ accentColor: "var(--accent)", width: 15, height: 15, flexShrink: 0 }}
            />
            <span style={{ fontSize: 11.5, fontWeight: 650, color: C.text }}>{automatic.label}</span>
          </label>
          {automatic.body}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${C.line}`, marginTop: 4, padding: "9px 8px 3px" }}>
        <button
          onClick={onOpenDate}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "none",
            border: "none",
            padding: "2px 4px",
            cursor: "pointer",
            fontFamily: font,
            textAlign: "left",
            color: C.text,
          }}
        >
          <Ico d="M4 6.5h16v14H4z M8 4v3M16 4v3M4 10.5h16" size={15} color={C.mute} sw={1.8} />
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{dateLabel}</span>
          <span style={{ fontSize: 11, color: C.mute, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{dateHint}</span>
          <span style={{ color: C.mute, fontSize: 14 }}>›</span>
        </button>
        {splitAction && (
          <button
            onClick={splitAction.onClick}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              color: "var(--accent)",
              fontSize: 11.5,
              fontWeight: 650,
              cursor: "pointer",
              padding: "2px 4px",
              fontFamily: font,
              whiteSpace: "nowrap",
            }}
          >
            {splitAction.label}
          </button>
        )}
      </div>
    </div>
  );
}

function EndpointRow({ endpoint, showEffect }: { endpoint: FlowEndpoint; showEffect: boolean }) {
  const C = useTheme();
  const M = useMask();
  const { role, name, color, icon, before, after, afterColor, hint, pillTint, onOpen, placeholder } = endpoint;
  return (
    <button
      onClick={onOpen}
      disabled={!onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        background: "none",
        border: "none",
        borderRadius: 12,
        padding: "8px 8px",
        cursor: onOpen ? "pointer" : "default",
        fontFamily: font,
        textAlign: "left",
        color: C.text,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: tint(color, 0.2),
        }}
      >
        <Glyph name={icon} size={16} color={color} sw={1.8} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ ...EYEBROW, color: C.mute }}>{role}</span>
        <span
          style={{
            display: "block",
            fontSize: 13.5,
            fontWeight: 700,
            color: placeholder ? C.mute : C.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
      </span>
      {!placeholder && (
        <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {showEffect ? (
            <>
              <span style={{ display: "block", fontSize: 10.5, color: C.mute, textDecoration: "line-through", whiteSpace: "nowrap" }}>{M(before)}</span>
              <span
                style={{
                  display: "inline-block",
                  background: pillTint,
                  borderRadius: 9,
                  padding: "3px 9px",
                  fontSize: 13.5,
                  fontWeight: 750,
                  whiteSpace: "nowrap",
                  color: afterColor,
                }}
              >
                {M(after)}
              </span>
              <span style={{ display: "block", fontSize: 10, color: C.soft, whiteSpace: "nowrap", marginTop: 2 }}>{hint}</span>
            </>
          ) : (
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 750, whiteSpace: "nowrap", color: afterColor }}>{M(after)}</span>
          )}
        </span>
      )}
      {onOpen && <span style={{ color: C.mute, fontSize: 15, flexShrink: 0 }}>›</span>}
    </button>
  );
}

/** The split list, in the card in place of the single envelope row. */
function SplitPanelBody({ split }: { split: SplitPanel }) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const envById = new Map(split.envelopes.map((e) => [e.id, e]));
  const sum = split.items.reduce((s, i) => s + i.amount, 0);
  const sumColor = sum === split.total ? C.pos : sum > split.total ? C.neg : C.warn;
  return (
    <div style={{ padding: "2px 8px 0" }}>
      <div style={{ padding: "0 0 6px" }}>
        <span style={{ ...EYEBROW, color: C.mute, textTransform: "uppercase" }}>{split.label}</span>
      </div>
      {split.items.map((it, idx) => {
        const e = envById.get(it.envelopeId);
        const color = e?.color ?? C.mute;
        const after = e ? e.available + (split.plus ? it.amount : -it.amount) : 0;
        const active = split.activeIndex === idx;
        return (
          <div
            key={idx} // positional: the same envelope may legitimately repeat across rows
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `1px solid ${C.line}` }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 9,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: tint(color, 0.2),
              }}
            >
              {e && <Glyph name={e.icon} size={14} color={color} sw={1.8} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: e ? C.text : C.mute,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e?.name ?? t("Choose an envelope")}
              </span>
              {e && (
                <span style={{ display: "block", fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
                  {after < 0 ? t("over by {amount}", { amount: M(-after) }) : t("{amount} left", { amount: M(after) })}
                </span>
              )}
            </span>
            <button
              onClick={() => split.onFocusItem(idx)}
              style={{
                background: active ? "var(--accent-1a)" : C.chip,
                border: `1.5px solid ${active ? "var(--accent)" : "transparent"}`,
                borderRadius: 9,
                padding: "5px 10px",
                fontSize: 12.5,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                cursor: "pointer",
                fontFamily: font,
                color: active ? "var(--accent)" : C.text,
                flexShrink: 0,
              }}
            >
              {M(it.amount)}
            </button>
            <button
              onClick={() => split.onRemoveItem(idx)}
              aria-label={t("Remove")}
              style={{ background: "none", border: "none", color: C.neg, fontSize: 14, cursor: "pointer", fontFamily: font, padding: "2px 4px", flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        onClick={split.onAddItem}
        style={{
          width: "100%",
          background: "none",
          border: `1.3px dashed ${C.line}`,
          borderRadius: 11,
          padding: "9px 0",
          marginTop: 8,
          color: C.soft,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("+ Add item")}
      </button>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "baseline",
          gap: 6,
          padding: "9px 0 4px",
          fontSize: 11.5,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ color: C.soft }}>{t("Item total: {sum} / {total}", { sum: M(sum), total: M(split.total) })}</span>
        {sum === split.total ? (
          <span style={{ fontWeight: 750, color: sumColor }}>✓</span>
        ) : (
          split.items.length > 0 &&
          split.total > 0 && (
            <button
              onClick={split.onAssignRest}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--accent)",
                fontSize: 11,
                fontWeight: 650,
                cursor: "pointer",
                fontFamily: font,
              }}
            >
              {t("assign the rest")} ›
            </button>
          )
        )}
      </div>
    </div>
  );
}
