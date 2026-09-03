import { useSyncExternalStore } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { importJobManager } from "../lib/importJobs/manager";
import { importActivityAttention } from "../lib/importJobs/store";
import { CORAL, TEAL } from "../lib/theme";

export function ImportActivityBadge({ onOpen }: { onOpen: () => void }) {
  const C = useTheme();
  const { tp } = useT();
  useSyncExternalStore(importJobManager.subscribe, importJobManager.activityVersion);
  const items = importJobManager.activityItems();
  const counts = {
    ready: items.filter((item) => importActivityAttention(item) === "ready").length,
    failed: items.filter((item) => importActivityAttention(item) === "failed").length,
  };
  const count = counts.ready + counts.failed;
  if (count === 0) return null;
  const label = tp("{n} import needs attention — open Imports | {n} imports need attention — open Imports", count);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      style={{
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
