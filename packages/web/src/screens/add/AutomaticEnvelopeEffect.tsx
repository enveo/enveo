import type { AutomaticEnvelopeEffectData, AutomaticEnvelopeEffectTone } from "../../lib/automaticEnvelopeUi";
import { useTheme } from "../../lib/contexts";
import { P } from "../../lib/theme";

const toneColor = (tone: AutomaticEnvelopeEffectTone, colors: { pos: string; neg: string; soft: string }): string =>
  tone === "positive" ? colors.pos : tone === "negative" ? colors.neg : colors.soft;

/** Callback-free rendering of controller-formatted automatic-envelope effect data. */
export function AutomaticEnvelopeEffect({ data, compact = false }: { data: AutomaticEnvelopeEffectData; compact?: boolean }) {
  const C = useTheme();
  return (
    <div
      style={{
        margin: compact ? "6px 0 0" : `10px ${P}px 2px`,
        padding: compact ? "6px 8px" : "9px 11px",
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        background: C.inset,
      }}
    >
      <div style={{ color: C.mute, fontSize: compact ? 9 : 10, fontWeight: 700, letterSpacing: 0.45, textTransform: "uppercase", marginBottom: 4 }}>
        {data.heading}
      </div>
      {data.neutral ? (
        <div style={{ color: C.soft, fontSize: compact ? 10 : 11.5, fontWeight: 600 }}>{data.noEnvelopeChange}</div>
      ) : (
        <>
          {data.rows.map((row, index) => (
            <div
              key={`${row.name}:${index}`}
              style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: compact ? 10 : 11.5, marginTop: 2 }}
            >
              <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
              <span style={{ color: toneColor(row.tone, C), fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{row.amount}</span>
            </div>
          ))}
          <div style={{ height: 1, background: C.line, margin: "5px 0 3px" }} />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: compact ? 10 : 11.5 }}>
            <span style={{ color: C.soft }}>{data.readyToAssign.name}</span>
            <span style={{ color: toneColor(data.readyToAssign.tone, C), fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {data.readyToAssign.amount}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
