import { useEffect, useState } from "react";
import { Sheet } from "../../components/chrome";
import { HighlightedText, PickerSearch } from "../../components/kit";
import type { StateResponse } from "../../lib/api";
import { useMask } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../../lib/search";
import { TEAL, tint } from "../../lib/theme";

/** Source-account picker sheet (radio ring + tinted icon rows + balance). Owns
 *  only its search query, reset whenever the sheet opens; selection goes back to
 *  the controller via `onSelect` (which also closes the sheet). */
export function AccountPickerSheet({
  show,
  onClose,
  accounts,
  selectedId,
  onSelect,
}: {
  show: boolean;
  onClose: () => void;
  accounts: StateResponse["accounts"];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const M = useMask();
  const [accQ, setAccQ] = useState("");
  useEffect(() => {
    if (show) setAccQ("");
  }, [show]);
  return (
    <Sheet show={show} onClose={onClose} tall={accounts.length > SEARCH_THRESHOLD}>
      {(C) => {
        const filtered = accounts.filter((a) => matchesSearch(a.name, accQ));
        return (
          <>
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 10 }}>{t("Choose an account")}</div>
              {accounts.length > SEARCH_THRESHOLD && <PickerSearch value={accQ} onChange={setAccQ} />}
            </div>
            <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
              {filtered.length === 0 ? (
                <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
              ) : (
                filtered.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      width: "100%",
                      padding: "9px 0",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        border: `2px solid ${selectedId === a.id ? TEAL : C.line}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {selectedId === a.id && <div style={{ width: 11, height: 11, borderRadius: "50%", background: TEAL }} />}
                    </div>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: tint(a.color, 0.15),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Glyph name={a.icon} size={16} color={a.color} />
                    </div>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: 14, color: C.text, fontWeight: 500 }}>
                      <HighlightedText text={a.name} query={accQ} />
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: a.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {M(a.balance)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        );
      }}
    </Sheet>
  );
}

/** Destination-account picker sheet — the same rows as the source sheet; the
 *  source account is excluded via `excludeId` exactly like the inline original. */
export function DestinationAccountSheet({
  show,
  onClose,
  accounts,
  excludeId,
  selectedId,
  onSelect,
}: {
  show: boolean;
  onClose: () => void;
  accounts: StateResponse["accounts"];
  excludeId: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const M = useMask();
  const [toQ, setToQ] = useState("");
  useEffect(() => {
    if (show) setToQ("");
  }, [show]);
  return (
    <Sheet show={show} onClose={onClose} tall={accounts.filter((a) => a.id !== excludeId).length > SEARCH_THRESHOLD}>
      {(C) => {
        const destAccounts = accounts.filter((a) => a.id !== excludeId);
        const filtered = destAccounts.filter((a) => matchesSearch(a.name, toQ));
        return (
          <>
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 10 }}>{t("Destination account")}</div>
              {destAccounts.length > SEARCH_THRESHOLD && <PickerSearch value={toQ} onChange={setToQ} />}
            </div>
            <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
              {filtered.length === 0 ? (
                <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
              ) : (
                filtered.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      width: "100%",
                      padding: "9px 0",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        border: `2px solid ${selectedId === a.id ? TEAL : C.line}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {selectedId === a.id && <div style={{ width: 11, height: 11, borderRadius: "50%", background: TEAL }} />}
                    </div>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: tint(a.color, 0.15),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Glyph name={a.icon} size={16} color={a.color} />
                    </div>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: 14, color: C.text, fontWeight: 500 }}>
                      <HighlightedText text={a.name} query={toQ} />
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: a.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {M(a.balance)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        );
      }}
    </Sheet>
  );
}
