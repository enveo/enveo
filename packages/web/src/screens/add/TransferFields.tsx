import { SectionEyebrow } from "../../components/kit";
import type { StateResponse } from "../../lib/api";
import type { AutomaticEnvelopeEffectData } from "../../lib/automaticEnvelopeUi";
import { useMask, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { P } from "../../lib/theme";
import { AutomaticEnvelopeEffect } from "./AutomaticEnvelopeEffect";
import { collapsedRowStyle, gridCardStyle, linkBtnStyle } from "./styles";

/** Destination-account UI of the transfer tab: eyebrow link to the full sheet,
 *  the suggestion grid when open, otherwise the collapsed accent row.
 *  Presentational — selection state and the sheet live in the controller. */
export function TransferFields({
  destOpen,
  destList,
  toAccountId,
  toAcc,
  onOpenSheet,
  onPickDest,
  automaticEffect,
}: {
  destOpen: boolean;
  destList: StateResponse["accounts"];
  toAccountId: string;
  toAcc: StateResponse["accounts"][number] | undefined;
  onOpenSheet: () => void;
  onPickDest: (id: string) => void;
  automaticEffect: AutomaticEnvelopeEffectData | null;
}) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  return (
    <>
      <SectionEyebrow
        label={t("Destination account")}
        right={
          <button onClick={onOpenSheet} style={linkBtnStyle}>
            {destOpen ? t("All") : t("Change")} ›
          </button>
        }
      />
      {destOpen ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, padding: `0 ${P}px` }}>
          {destList.map((a) => (
            <button key={a.id} onClick={() => onPickDest(a.id)} style={gridCardStyle(C, a.id === toAccountId)}>
              <Glyph name={a.icon} size={15} color={a.color} sw={1.8} />
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 650,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </span>
                <span style={{ display: "block", fontSize: 9, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{M(a.balance)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <button onClick={onOpenSheet} style={collapsedRowStyle(C, true)}>
          {toAcc && <Glyph name={toAcc.icon} size={17} color={toAcc.color} sw={1.8} />}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 650,
              color: C.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {toAcc?.name ?? t("Destination account")}
          </span>
        </button>
      )}
      {automaticEffect && <AutomaticEnvelopeEffect data={automaticEffect} />}
    </>
  );
}
