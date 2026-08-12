import { Sheet } from "../../components/chrome";
import { ScrollPicker } from "../../components/pickers";
import { monthNames } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { TEAL } from "../../lib/theme";

export function DateSheet({ show, date, onClose, onChange }: { show: boolean; date: string; onClose: () => void; onChange: (iso: string) => void }) {
  const { t, lang } = useT();
  const months = monthNames(lang);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const set = (day: number, monIdx: number, year: number) => {
    const maxDay = new Date(Date.UTC(year, monIdx + 1, 0)).getUTCDate();
    const dd = Math.min(day, maxDay);
    onChange(`${year}-${String(monIdx + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`);
  };
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const years = [y - 2, y - 1, y, y + 1, y + 2].filter((v, i, a) => a.indexOf(v) === i);
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <Sheet show={show} onClose={onClose} lockSwipe>
      {(C) => (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
            <button
              onClick={() => {
                const dt = new Date(`${todayIso}T00:00Z`);
                dt.setUTCDate(dt.getUTCDate() - 1);
                onChange(dt.toISOString().slice(0, 10));
                onClose();
              }}
              style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
            >
              {t("Yesterday")}
            </button>
            <button
              onClick={() => {
                onChange(todayIso);
                onClose();
              }}
              style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
            >
              {t("Today")}
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
              OK
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
            <ScrollPicker items={days} selected={d} onSelect={(v) => set(v, m - 1, y)} width="28%" />
            <ScrollPicker items={months} selected={months[m - 1]!} onSelect={(v) => set(d, months.indexOf(v), y)} width="44%" />
            <ScrollPicker items={years} selected={y} onSelect={(v) => set(d, m - 1, v)} width="28%" />
          </div>
        </>
      )}
    </Sheet>
  );
}
