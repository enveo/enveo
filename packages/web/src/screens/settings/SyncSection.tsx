import type { OpKind, SyncOp } from "@enveo/shared";
import { useEffect, useState } from "react";
import { useSyncStatus } from "../../lib/api";
import { useCurrency, useTheme } from "../../lib/contexts";
import { exportBackup } from "../../lib/data";
import { relSync } from "../../lib/dates";
import { formatMoney } from "../../lib/format";
import { type Lang, type Message, msg, useT } from "../../lib/i18n";
import { type RepairResult, rebuildLocalReplica } from "../../lib/localRepair";
import { discardDeadLetter, getDeadLetters } from "../../lib/outbox";
import { discardLocalReplica, recheckReplicaOwner, syncNow } from "../../lib/sync";
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
  const { ownerUnproven } = useSyncStatus();
  // The replica's owner could not be established: no cycle writes anything and none will until
  // the proof succeeds, so "Sync now" / "Download everything anew" would be theatre. The notice
  // takes the section over — it is the ONE place where this state is explained.
  //
  // The gate is the STICKY ownerUnproven, never SyncState "unverified": a re-proof runs as a normal
  // cycle, which flips the state to "syncing" first — keying on the state would tear this panel
  // down (with its open discard confirmation and its "Checking…" label) on every 60 s interval,
  // every focus, every local edit and, absurdly, on the "Check again" tap that starts the proof.
  if (ownerUnproven) {
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
      // The panel STAYS mounted for the whole proof (the section's gate is sticky), so "Checking…"
      // is visible; the component unmounts only if the proof SUCCEEDS (ownerUnproven cleared).
      await recheckReplicaOwner();
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
      await discardLocalReplica(); // clears IDB + outbox, then reloads
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
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("Not syncing with your account")}</div>
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 8 }}>
          {t(
            "The copy of the budget on this device has not been matched to the account you are signed in with. Nothing is being sent to the server and nothing has been deleted — your changes are waiting safely here. There are two reasons this happens:",
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Cause>
            {t(
              "An upgrade or a restore is in progress: the account's budget on the server is not this device's budget yet. Once it is, sync will resume by itself.",
            )}
          </Cause>
          <Cause>
            {t("This data may belong to a different account. Then it will never be sent — download a backup and remove the copy from this device.")}
          </Cause>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <ActionGroup>
          <ActionRow
            icon={<ActionIcon paths={IC.refresh} />}
            label={t("Check again")}
            desc={t("re-runs the check against the server; nothing is sent")}
            onClick={() => void recheck()}
            disabled={busy}
            busyLabel={busy ? t("Checking…") : undefined}
          />
          <ActionRow
            icon={<ActionIcon paths={IC.download} />}
            label={t("Download a backup (JSON)")}
            desc={t("the whole local copy as a file — no network needed")}
            onClick={doExport}
            disabled={busy}
          />
          <ActionRow
            icon={<ActionIcon paths={IC.trash} />}
            label={t("Remove this data and continue")}
            desc={t("removes the local copy and downloads your account's data")}
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
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
            {t(
              "The local copy — including any unsent changes — will be permanently removed from this device. If this is the only copy of that budget, download a backup first.",
            )}
          </div>
          <ActionButton
            variant="coral"
            label={busy ? t("Removing…") : t("Yes, remove the data from this device")}
            onClick={() => void doDiscard()}
            disabled={busy}
          />
          <ActionButton label={t("Cancel")} onClick={() => setConfirm(false)} disabled={busy} style={{ marginTop: 8 }} />
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
      <div style={{ fontSize: 11, color: C.mute, lineHeight: 1.6, margin: "10px 4px 0" }}>
        {t("The check repeats by itself when you open the app, and roughly once a minute.")}
      </div>
    </div>
  );
}

/** Op kind → what the user sees in the rejected-changes list. */
const OP_LABEL: Record<OpKind, Message> = {
  "txn.create": msg("New transaction"),
  "txn.update": msg("Transaction change"),
  "txn.delete": msg("Transaction deletion"),
  "alloc.set": msg("Envelope allocation"),
  "account.create": msg("New account"),
  "account.update": msg("Account change"),
  "account.delete": msg("Account deletion"),
  "group.create": msg("New envelope group"),
  "group.update": msg("Envelope group change"),
  "group.delete": msg("Envelope group deletion"),
  "envelope.create": msg("New envelope"),
  "envelope.update": msg("Envelope change"),
  "envelope.delete": msg("Envelope deletion"),
  "category.create": msg("New category"),
  "place.create": msg("New place"),
  "category.update": msg("Category change"),
  "place.update": msg("Place change"),
  "category.delete": msg("Category deletion"),
  "place.delete": msg("Place deletion"),
  "budget.update": msg("Budget currency change"),
  "budget.preferences.update": msg("Budget settings change"),
};

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

/** Sync action group with one safe local-repair flow and the status below it. */
function SyncActions() {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { state, pending, lastSyncAt } = useSyncStatus();
  const [repairing, setRepairing] = useState(false);
  const [blocked, setBlocked] = useState<Extract<RepairResult, { kind: "blocked" }>["reason"] | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);

  // refresh the relative time every ~30 s while the section is open
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const repair = async () => {
    setRepairing(true);
    setBlocked(null);
    setRepairError(null);
    try {
      const result = await rebuildLocalReplica();
      if (result.kind === "blocked") setBlocked(result.reason);
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairing(false);
    }
  };

  const repairExport = () => {
    setRepairError(null);
    try {
      exportBackup();
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    }
  };

  const repairDiscard = async () => {
    if (
      !window.confirm(
        t(
          "The local copy — including any unsent changes — will be permanently removed from this device. If this is the only copy of that budget, download a backup first.",
        ),
      )
    )
      return;
    await discardLocalReplica();
  };

  return (
    <div style={{ marginTop: 14 }}>
      <Eyebrow>{t("Server sync")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.refresh} />}
          label={t("Sync now")}
          desc={t("sends pending changes and fetches new ones from the server")}
          onClick={() => void syncNow("manual")}
          disabled={state === "syncing"}
          busyLabel={state === "syncing" ? t("Syncing…") : undefined}
        />
        <ActionRow
          icon={<ActionIcon paths={IC.redownload} />}
          label={t("Rebuild data on this device")}
          desc={t("Downloads a fresh server copy, then reapplies changes still waiting to be sent.")}
          onClick={() => void repair()}
          disabled={repairing || state === "syncing"}
          busyLabel={repairing ? t("Rebuilding…") : undefined}
        />
      </ActionGroup>
      {blocked && (
        <div style={{ marginTop: 10, padding: 12, background: C.bg, borderRadius: 11, border: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
            {blocked === "outbox_unreadable"
              ? t("The pending-change queue cannot be read safely, so Enveo left the local copy untouched.")
              : blocked === "locked"
                ? t("Unlock this encrypted budget before rebuilding the local copy.")
                : t("This device's local copy could not be confirmed to belong to the signed-in account — nothing was changed.")}
          </div>
          <ActionGroup>
            <ActionRow label={t("Download a backup (JSON)")} desc={t("the whole local copy as a file — no network needed")} onClick={repairExport} />
            <ActionRow label={t("Remove this data and continue")} tone="danger" onClick={() => void repairDiscard()} />
          </ActionGroup>
        </div>
      )}
      {repairError && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{repairError}</div>}
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, margin: "8px 4px 0" }}>
        {t("Last sync: {rel}.", { rel: relSync(lastSyncAt, lang) })}
        {pending > 0
          ? /* Whole sentences, never fragments glued mid-clause: a translator gets the complete
               clause and each language keeps its own word order (see i18n.test.ts). */
            ` ${tp("{n} change is waiting to be sent | {n} changes are waiting to be sent", pending)}.${state === "offline" || state === "error" ? ` ${t("We will send them once the server is reachable.")}` : ""}`
          : (state === "offline" || state === "error") && ` ${t("Server temporarily unreachable — your data is safe, we will retry.")}`}
      </div>
    </div>
  );
}

/** Rejected changes list (dead-letters) — no logic changes, just the list. */
function DeadLetters() {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  const deadLetters = getDeadLetters();
  if (deadLetters.length === 0) return null;
  return (
    <div style={{ marginTop: 14, padding: 12, background: C.bg, borderRadius: 11, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 4 }}>
        {t(
          "The server rejected these changes — usually because you edited something that was meanwhile deleted on another device. Your data has already been restored to the server state. “Discard” removes the failed attempt from the list.",
        )}
      </div>
      {deadLetters.map((dl, i) => (
        <div
          key={dl.opId}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            padding: "10px 0",
            borderTop: i === 0 ? "none" : `1px solid ${C.line}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {/* defensive fallback: a dead-letter persisted in IDB by an OLDER app build can still
                carry an op kind from a feature retired since then, at RUNTIME, even though
                `dl.op.kind` is statically typed against the CURRENT OpKind — OP_LABEL has no
                entry for it, so the lookup below is `undefined` despite the full Record type. */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{t(OP_LABEL[dl.op.kind] ?? msg("Change"))}</div>
            {opDetail(dl.op, currency, lang) && <div style={{ fontSize: 11, color: C.soft, marginTop: 1 }}>{opDetail(dl.op, currency, lang)}</div>}
            <div style={{ fontSize: 11, color: CORAL, marginTop: 2, lineHeight: 1.4, wordBreak: "break-word" }}>{dl.error}</div>
            <div style={{ fontSize: 10.5, color: C.mute, marginTop: 2 }}>{relSync(dl.at, lang)}</div>
          </div>
          <button
            onClick={() => discardDeadLetter(dl.opId)}
            style={{
              flexShrink: 0,
              padding: "6px 12px",
              borderRadius: 8,
              border: `1px solid ${C.line}`,
              background: "transparent",
              color: C.soft,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Discard")}
          </button>
        </div>
      ))}
    </div>
  );
}
