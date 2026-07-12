import { useEffect, useState } from "react";
import type { SyncOp } from "@enveo/shared";
import { useSyncStatus } from "../../lib/api";
import { useCurrency, useTheme } from "../../lib/contexts";
import { relSync } from "../../lib/dates";
import { formatMoney } from "../../lib/format";
import { useT, type Lang, type TKey } from "../../lib/i18n";
import { discardDeadLetter, getDeadLetters } from "../../lib/outbox";
import { fullResync, syncNow } from "../../lib/sync";
import { CORAL } from "../../lib/theme";
import { ActionGroup, ActionIcon, ActionRow, Eyebrow } from "./ui";

/* ── Sync: action rows + status + rejected changes ──────────────────── */

/** Action row glyphs (stroke 1.8, consistent with the variant A mock). */
const IC = {
  refresh: ["M23 4v6h-6", "M20.49 15a9 9 0 11-2.12-9.36L23 10"],
  redownload: ["M8 17l4 4 4-4", "M12 12v9", "M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"],
};

export function SyncSection() {
  return (
    <div style={{ marginTop: 4 }}>
      <SyncActions />
      <DeadLetters />
    </div>
  );
}

/** Short, human description of a rejected op (no jargon — name / amount / month). */
function opDetail(op: SyncOp, currency: string, lang: Lang): string {
  const p = op.payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.name === "string" && p.name.trim()) parts.push(p.name.trim());
  if (op.kind === "alloc.set") {
    if (typeof p.amount === "number") parts.push(formatMoney(p.amount, currency, lang));
    if (typeof p.month === "string") parts.push(p.month);
  } else if ((op.kind === "txn.create" || op.kind === "txn.update") && typeof p.amount === "number") {
    parts.push(formatMoney(p.amount, currency, lang));
  }
  return parts.join(" · ");
}

/** Sync action group (sync-now + full resync) with the status BELOW the group. */
function SyncActions() {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { state, pending, lastSyncAt, localMode } = useSyncStatus();

  // refresh the relative time every ~30 s while the section is open
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (localMode !== "off") {
    // In local mode sync is PAUSED — we hide "sync now",
    // "download again" and the rejection list (nothing to push or pull).
    return (
      <div style={{ marginTop: 14, fontSize: 11.5, color: C.soft, lineHeight: 1.6 }}>
        {t("sync.pausedLocal")}{" "}
        {localMode === "wiped" ? t("sync.pausedWiped") : t("sync.pausedInfo")}
        {pending > 0 && ` ${tp("sync.pendingLocal", pending)}`}
        {" "}
        {t("sync.resumeHint")}
      </div>
    );
  }

  const resync = () => {
    if (!window.confirm(t("sync.resyncConfirm"))) return;
    void fullResync();
  };

  return (
    <div style={{ marginTop: 14 }}>
      <Eyebrow>{t("settings.groupSync")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.refresh} />}
          label={t("sync.syncNow")}
          desc={t("sync.syncNowDesc")}
          onClick={() => void syncNow("manual")}
          disabled={state === "syncing"}
          busyLabel={state === "syncing" ? t("sync.syncing") : undefined}
        />
        <ActionRow icon={<ActionIcon paths={IC.redownload} />} label={t("sync.resyncBtn")} desc={t("sync.resyncHelp")} onClick={resync} />
      </ActionGroup>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, margin: "8px 4px 0" }}>
        {t("sync.last", { rel: relSync(lastSyncAt, lang) })}
        {pending > 0
          ? ` ${tp("sync.pendingSend", pending)}${state === "offline" || state === "error" ? t("sync.offlineSuffix") : ""}.`
          : (state === "offline" || state === "error") && ` ${t("sync.offlineInfo")}`}
      </div>
    </div>
  );
}

/** Rejected changes list (dead-letters) — no logic changes, just the list. */
function DeadLetters() {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  const { localMode } = useSyncStatus();
  const deadLetters = getDeadLetters();
  if (localMode !== "off" || deadLetters.length === 0) return null; // in local mode there is nothing to pull
  return (
    <div style={{ marginTop: 14, padding: 12, background: C.bg, borderRadius: 11, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 4 }}>
        {t("sync.deadLettersInfo")}
      </div>
      {deadLetters.map((dl, i) => (
        <div key={dl.opId} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 0", borderTop: i === 0 ? "none" : `1px solid ${C.line}` }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{t(`op.${dl.op.kind}` as TKey)}</div>
            {opDetail(dl.op, currency, lang) && <div style={{ fontSize: 11, color: C.soft, marginTop: 1 }}>{opDetail(dl.op, currency, lang)}</div>}
            <div style={{ fontSize: 11, color: CORAL, marginTop: 2, lineHeight: 1.4, wordBreak: "break-word" }}>{dl.error}</div>
            <div style={{ fontSize: 10.5, color: C.mute, marginTop: 2 }}>{relSync(dl.at, lang)}</div>
          </div>
          <button
            onClick={() => discardDeadLetter(dl.opId)}
            style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.soft, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
          >
            {t("sync.discard")}
          </button>
        </div>
      ))}
    </div>
  );
}
