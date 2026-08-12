import { useEffect, useState } from "react";
import { Sheet } from "../../components/chrome";
import { HighlightedText, PickerSearch } from "../../components/kit";
import type { StateResponse } from "../../lib/api";
import { useMask } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../../lib/search";
import { tint } from "../../lib/theme";

/** Full grouped envelope picker sheet (group headers + available amounts).
 *  Owns only its search query, reset whenever the sheet opens; selection goes
 *  back to the controller via `onSelect` (which also closes the sheet). */
export function EnvelopePickerSheet({
  show,
  onClose,
  envelopes,
  groups,
  onSelect,
}: {
  show: boolean;
  onClose: () => void;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onSelect: (id: string) => void;
}) {
  const M = useMask();
  const { t } = useT();
  const [envQ, setEnvQ] = useState("");
  useEffect(() => {
    if (show) setEnvQ("");
  }, [show]);
  return (
    <Sheet show={show} onClose={onClose} tall={envelopes.filter((e) => !e.archived).length > SEARCH_THRESHOLD}>
      {(C) => {
        const allEnvelopes = envelopes.filter((e) => !e.archived);
        const grouped = [...groups]
          .sort((a, b) => a.sort - b.sort)
          .map((g) => ({ group: g, list: allEnvelopes.filter((e) => e.groupId === g.id && matchesSearch(e.name, envQ)) }))
          .filter((g) => g.list.length > 0);
        return (
          <>
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14, textAlign: "center" }}>{t("Choose an envelope")}</div>
              {allEnvelopes.length > SEARCH_THRESHOLD && <PickerSearch value={envQ} onChange={setEnvQ} />}
            </div>
            <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
              {grouped.length === 0 ? (
                <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
              ) : (
                grouped.map(({ group: g, list }) => (
                  <div key={g.id} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 8 }}>{g.name}</div>
                    <div>
                      {list.map((e) => (
                        <button
                          key={e.id}
                          onClick={() => onSelect(e.id)}
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
                            <HighlightedText text={e.name} query={envQ} />
                          </span>
                          <span style={{ fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: e.available < 0 ? C.neg : C.text }}>
                            {e.available < 0 ? "−" : ""}
                            {M(Math.abs(e.available))}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        );
      }}
    </Sheet>
  );
}
