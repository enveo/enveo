import { useEffect, useState } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { importJobManager } from "../lib/importJobs/manager";
import { CORAL, TEAL } from "../lib/theme";

export function ImportActivityBadge({ onOpen }: { onOpen: () => void }) {
  const C = useTheme();
  const { tp } = useT();
  const [counts, setCounts] = useState({ ready: 0, failed: 0 });
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const items = await importJobManager.list();
      if (active) {
        setCounts({ ready: items.filter((item) => item.status === "ready").length, failed: items.filter((item) => item.status === "failed").length });
      }
    };
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const count = counts.ready + counts.failed;
  if (count === 0) return null;
  const label = tp("{n} import needs attention — open Activity | {n} imports need attention — open Activity", count);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      style={{
        position: "absolute",
        top: "calc(env(safe-area-inset-top) + 13px)",
        right: 48,
        zIndex: 61,
        minWidth: 20,
        height: 20,
        padding: "0 5px",
        borderRadius: 999,
        border: `1px solid ${C.line}`,
        background: C.card,
        color: counts.failed > 0 ? CORAL : TEAL,
        fontSize: 10.5,
        fontWeight: 800,
        cursor: "pointer",
      }}
    >
      {count}
    </button>
  );
}
