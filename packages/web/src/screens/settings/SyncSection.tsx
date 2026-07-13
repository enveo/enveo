import { useEffect, useState } from "react";
import type { SyncOp } from "@enveo/shared";
import { useSyncStatus } from "../../lib/api";
import { useCurrency, useTheme } from "../../lib/contexts";
import { exportBackup } from "../../lib/data";
import { relSync } from "../../lib/dates";
import { formatMoney } from "../../lib/format";
import { useT, type Lang, type TKey } from "../../lib/i18n";
import { discardDeadLetter, getDeadLetters } from "../../lib/outbox";
import { discardLocalReplica, fullResync, recheckReplicaOwner, syncNow } from "../../lib/sync";
import { CORAL } from "../../lib/theme";
import { ActionButton, ActionGroup, ActionIcon, ActionRow, Eyebrow } from "./ui";

/* ── Sync: action rows + status + rejected changes ──────────────────── */

/** Action row glyphs (stroke 1.8, consistent with the variant A mock). */
const IC = {
  refresh: ["M23 4v6h-6", "M20.49 15a9 9 0 11-2.12-9.36L23 10"],
  redownload: ["M8 17l4 4 4-4", "M12 12v9", "M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"],
  download: ["M12 3v12", "M7 12l5 5 5-5", "M5 21h14"],
  trash: ["M4 7h16", "M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2", "M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"],
};

export function SyncSection() {
  const { state, localMode } = useSyncStatus();
  // The replica's owner could not be established: no cycle writes anything and none will until
  // the proof succeeds, so "Sync now" / "Download everything anew" would be theatre. The notice
  // takes the section over — it is the ONE place where this state is explained. (Local mode wins:
  // there sync is off by the user's own choice, and the SyncActions text already says so.)
  if (localMode === "off" && state === "unverified") {
    return (
      <div style={{ marginTop: 4 }}>
        <UnverifiedReplicaNotice />
        {/* Dead letters SURVIVE in IDB, so a device that upgraded with a rejected op still carries
            it here — and its red badge dot routes to exactly this section. Never swallow the list. */}
        <DeadLetters />
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4 }}>
      <SyncActions />
      <DeadLetters />
    </div>
  );
}

/**
 * SyncState "unverified" (see enterUnverified in lib/sync.ts) — the ForeignReplicaScreen story,
 * told inside Settings because here the app still WORKS: the data may well be this user's, so we
 * do not take the screen away from them; we only refuse to send anything until we can prove whose
 * it is.
 *
 * It names the two causes that actually produce this state — an upgrade/restore that has not
 * finished (sync resumes by itself), or data that belongs to another account (it never will) —
 * because the two demand opposite reactions: wait, or get the data out and start clean. And it
 * offers only affordances that already exist and destroy nothing on their own: re-run the proof,
 * export the whole ledger to a file, or (explicitly, behind a confirmation) discard the local copy.
 */
function UnverifiedReplicaNotice() {
  const C = useTheme();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      await recheckReplicaOwner(); // proof succeeded ⇒ this component unmounts (state ≠ unverified)
    } finally {
      setBusy(false);
    }
  };

  const doExport = () => {
    setError(null);
    try {
      exportBackup(); // local mirror → JSON file; no server call
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDiscard = async () => {
    setBusy(true);
    setError(null);
    try {
      await discardLocalReplica(); // clears IDB + outbox + local mode, then reloads
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const Cause = ({ children }: { children: React.ReactNode }) => (
    <div style={{ display: "flex", gap: 8, fontSize: 11.5, color: C.soft, lineHeight: 1.6 }}>
      <span aria-hidden style={{ color: C.mute }}>
        •
      </span>
      <span>{children}</span>
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ padding: 14, background: C.bg, borderRadius: 11, border: `1px solid ${C.line}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("unverified.title")}</div>
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 8 }}>{t("unverified.body")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Cause>{t("unverified.causeUpgrade")}</Cause>
          <Cause>{t("unverified.causeOther")}</Cause>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <ActionGroup>
          <ActionRow
            icon={<ActionIcon paths={IC.refresh} />}
            label={t("unverified.recheck")}
            desc={t("unverified.recheckDesc")}
            onClick={() => void recheck()}
            disabled={busy}
            busyLabel={busy ? t("unverified.rechecking") : undefined}
          />
          <ActionRow
            icon={<ActionIcon paths={IC.download} />}
            label={t("foreign.export")}
            desc={t("unverified.exportDesc")}
            onClick={doExport}
            disabled={busy}
          />
          <ActionRow
            icon={<ActionIcon paths={IC.trash} />}
            label={t("foreign.discard")}
            desc={t("unverified.discardDesc")}
            tone="danger"
            onClick={() => {
              setError(null);
              setConfirm(true);
            }}
            disabled={busy}
          />
        </ActionGroup>
      </div>

      {confirm && (
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: `1px solid var(--danger-66)` }}>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>{t("foreign.discardConfirm")}</div>
          <ActionButton
            variant="coral"
            label={busy ? t("foreign.discarding") : t("foreign.discardYes")}
            onClick={() => void doDiscard()}
            disabled={busy}
          />
          <ActionButton label={t("common.cancel")} onClick={() => setConfirm(false)} disabled={busy} style={{ marginTop: 8 }} />
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
      <div style={{ fontSize: 11, color: C.mute, lineHeight: 1.6, margin: "10px 4px 0" }}>{t("unverified.hint")}</div>
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
