import type { MigrationDifference, MigrationReceipt } from "@enveo/shared";
import { useRef, useState } from "react";
import { useMask, useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import {
  applyMigration,
  MigrationUploadPending,
  migrationBlockedByData,
  migrationErrorMessage,
  type PreparedMigration,
  prepareActualMigration,
  prepareFourGroszeMigration,
  prepareYnabMigration,
} from "../lib/migration";
import { fetchYnabPlan, listYnabPlans, readActualExport, readFourGroszeFile, readYnabFile, type YnabPlanSummary } from "../lib/migrationSources";
import { store } from "../lib/store";
import { font, TEAL } from "../lib/theme";
import { Surface } from "./chrome";

type Step = "source" | "ynab" | "plans" | "actual" | "fourGrosze" | "receipt" | "done";

const YNAB_TOKEN_URL = "https://app.ynab.com/settings/developer";

export function MigrationSheet({ show, onClose }: { show: boolean; onClose: () => void }) {
  return (
    <Surface show={show} onClose={onClose}>
      {() => <MigrationFlow onClose={onClose} />}
    </Surface>
  );
}

/** The onboarding wizard has no side panel to open a sheet in, so it hosts this flow in its own column. */
export function MigrationFlow({ onClose, onMigrated }: { onClose: () => void; onMigrated?: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const [step, setStep] = useState<Step>("source");
  const [token, setToken] = useState("");
  const [plans, setPlans] = useState<YnabPlanSummary[]>([]);
  const [prepared, setPrepared] = useState<PreparedMigration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const ynabFile = useRef<HTMLInputElement>(null);
  const actualFile = useRef<HTMLInputElement>(null);
  const fourGroszeFile = useRef<HTMLInputElement>(null);

  const close = () => {
    if (busy) return;
    onClose();
    if (step === "done") onMigrated?.();
  };

  const back = () => {
    setError(null);
    setToken("");
    setPrepared(null);
    if (step === "source") close();
    else setStep("source");
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(t(migrationErrorMessage(cause)));
    } finally {
      setBusy(false);
    }
  };

  const showReceipt = (next: PreparedMigration) => {
    setToken("");
    setPrepared(next);
    setStep("receipt");
  };

  const connectYnab = () =>
    run(async () => {
      const listed = await listYnabPlans(token);
      if (listed.length === 1) showReceipt(prepareYnabMigration(await fetchYnabPlan(token, listed[0]!.id)));
      else {
        setPlans(listed);
        setStep("plans");
      }
    });

  const fileInput = (ref: React.RefObject<HTMLInputElement>, accept: string, read: (file: File) => Promise<PreparedMigration>) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      style={{ display: "none" }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void run(async () => showReceipt(await read(file)));
      }}
    />
  );

  const primary = {
    width: "100%",
    padding: "12px 0",
    borderRadius: 12,
    border: "none",
    background: TEAL,
    color: "#fff",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  };
  const secondary = { ...primary, background: "transparent", border: `1px solid ${C.line}`, color: C.text };
  const title = (text: string) => <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>{text}</div>;
  const hint = (text: string) => <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.55, marginBottom: 14 }}>{text}</div>;
  const blocked = step !== "done" && migrationBlockedByData(store.getLedger());

  return (
    <div style={{ fontFamily: font, width: "100%" }}>
      {blocked ? (
        <>
          {title(t("Move from another budgeting app"))}
          {hint(t("This budget already has transactions. Export a backup, reset the budget under Settings, and start the move again."))}
          <button style={secondary} onClick={close}>
            {t("Close")}
          </button>
        </>
      ) : step === "source" ? (
        <>
          {title(t("Move from another budgeting app"))}
          {hint(t("Your accounts, envelopes, assignments and history come along. The file or token stays in this browser until you confirm."))}
          <div style={{ display: "grid", gap: 10 }}>
            <button style={secondary} onClick={() => setStep("ynab")}>
              YNAB
            </button>
            <button style={secondary} onClick={() => setStep("actual")}>
              Actual Budget
            </button>
            <button style={secondary} onClick={() => setStep("fourGrosze")}>
              4grosze.pl
            </button>
          </div>
        </>
      ) : step === "ynab" ? (
        <>
          {title("YNAB")}
          {hint(t("Create a personal access token in YNAB and paste it here. It goes straight to YNAB, is not saved, and never reaches Enveo's server."))}
          <a href={YNAB_TOKEN_URL} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 12.5, color: C.text, marginBottom: 12 }}>
            {t("Open YNAB developer settings")}
          </a>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            aria-label={t("Personal access token")}
            placeholder={t("Personal access token")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.bg,
              color: C.text,
              fontSize: 16,
              fontFamily: font,
              marginBottom: 12,
            }}
          />
          <button
            style={{ ...primary, opacity: !token.trim() || busy ? 0.5 : 1, marginBottom: 10 }}
            disabled={!token.trim() || busy}
            onClick={() => void connectYnab()}
          >
            {busy ? t("Reading your budget…") : t("Continue")}
          </button>
          <button style={secondary} disabled={busy} onClick={() => ynabFile.current?.click()}>
            {t("Use a saved JSON file instead")}
          </button>
          {fileInput(ynabFile, "application/json,.json", async (file) => prepareYnabMigration(await readYnabFile(file)))}
        </>
      ) : step === "plans" ? (
        <>
          {title(t("Choose a budget"))}
          {hint(t("Each budget moves separately, and this one will replace the empty budget here."))}
          {plans.length === 0 && hint(t("This YNAB account has no budgets."))}
          <div style={{ display: "grid", gap: 10 }}>
            {plans.map((plan) => (
              <button
                key={plan.id}
                style={secondary}
                disabled={busy}
                onClick={() => void run(async () => showReceipt(prepareYnabMigration(await fetchYnabPlan(token, plan.id))))}
              >
                {plan.name}
              </button>
            ))}
          </div>
        </>
      ) : step === "actual" ? (
        <>
          {title("Actual Budget")}
          {hint(t("In Actual, open Settings and choose Export data, then select the zip file it downloads."))}
          <button style={{ ...primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => actualFile.current?.click()}>
            {busy ? t("Reading your budget…") : t("Choose the zip file")}
          </button>
          {fileInput(actualFile, "application/zip,.zip", async (file) => prepareActualMigration(await readActualExport(file)))}
        </>
      ) : step === "fourGrosze" ? (
        <>
          {title("4grosze.pl")}
          {hint(t("Export your data from 4grosze.pl as a JSON file, then select it here."))}
          <button style={{ ...primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => fourGroszeFile.current?.click()}>
            {busy ? t("Reading your budget…") : t("Choose the JSON file")}
          </button>
          {fileInput(fourGroszeFile, "application/json,.json", async (file) =>
            prepareFourGroszeMigration(await readFourGroszeFile(file), t("Archived envelopes")),
          )}
        </>
      ) : step === "receipt" && prepared ? (
        <>
          {title(prepared.receipt.budgetName)}
          <MigrationReceiptView receipt={prepared.receipt} currency={prepared.ledger.budgets[0]?.currency} />
          <button
            style={{ ...primary, opacity: busy ? 0.5 : 1 }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  await applyMigration(prepared);
                } catch (cause) {
                  if (!(cause instanceof MigrationUploadPending)) throw cause;
                  setUploadPending(true);
                }
                setStep("done");
              })
            }
          >
            {busy ? t("Saving…") : t("Bring it into Enveo")}
          </button>
        </>
      ) : (
        <>
          {title(t("Your budget is here"))}
          {hint(
            uploadPending
              ? t("Everything from the receipt is on this device. It will reach the server on the next sync, so keep your old budget until then.")
              : t("Everything from the receipt is now in Enveo. You can close your old app's budget whenever you are ready."),
          )}
          <button style={primary} onClick={close}>
            {t("Done")}
          </button>
        </>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: C.neg, lineHeight: 1.5, marginTop: 10 }}>
          {error}
        </div>
      )}
      {!blocked && step !== "done" && (
        <button style={{ ...secondary, marginTop: 10 }} disabled={busy} onClick={back}>
          {t("Back")}
        </button>
      )}
    </div>
  );
}

/** The figures are the imported budget's, so they read in its currency, not the one being replaced. */
function MigrationReceiptView({ receipt, currency }: { receipt: MigrationReceipt; currency: string | undefined }) {
  const C = useTheme();
  const mask = useMask();
  const M = (minor: number) => mask(minor, currency);
  const { t, tp } = useT();
  const balancesMatch = receipt.accountDifferences.length === 0;
  const envelopesMatch = receipt.envelopeDifferences.length === 0;
  const count = (label: string) => <div style={{ fontSize: 13, color: C.text, padding: "7px 0", borderTop: `1px solid ${C.line}` }}>{label}</div>;
  const differences = (rows: MigrationDifference[]) =>
    rows.map((row) => (
      <div key={row.name} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: C.soft, padding: "3px 0" }}>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{row.name}</span>
        <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {t("{expected} there, {actual} here", { expected: M(row.expected), actual: M(row.actual) })}
        </span>
      </div>
    ));
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginTop: 10 }}>
        {count(tp("{n} account | {n} accounts", receipt.accounts))}
        {count(tp("{n} envelope | {n} envelopes", receipt.envelopes))}
        {count(tp("{n} transaction | {n} transactions", receipt.transactions))}
      </div>
      {!receipt.balancesChecked ? (
        receipt.uncheckedBalances.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, color: C.text, lineHeight: 1.45 }}>
              {t("The file has no balances to check against. Compare these with your old app before you continue:")}
            </div>
            {receipt.uncheckedBalances.map((row) => (
              <div key={row.name} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: C.soft, padding: "3px 0" }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{row.name}</span>
                <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{M(row.amount)}</span>
              </div>
            ))}
          </>
        )
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, color: balancesMatch ? C.pos : C.warn }}>
            {balancesMatch ? t("Every account balance matches.") : t("These account balances do not match:")}
          </div>
          {differences(receipt.accountDifferences)}
        </>
      )}
      {!receipt.trackingOnly && receipt.envelopesChecked && (
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, color: envelopesMatch ? C.pos : C.warn }}>
          {envelopesMatch ? t("Every envelope matches this month's available amount.") : t("These envelopes do not match this month's available amount:")}
        </div>
      )}
      {differences(receipt.envelopeDifferences)}
      {!receipt.trackingOnly && !receipt.envelopesChecked && (
        <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.55, marginTop: 10 }}>
          {t("After the move, compare a few envelopes with your old app too.")}
        </div>
      )}
      {receipt.debtAccounts > 0 && (
        <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.55, marginTop: 10 }}>
          {t("Enveo has no card payment envelopes, so money owed on a card lowers what is left to budget.")}
        </div>
      )}
      {receipt.trackingOnly && (
        <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.55, marginTop: 10 }}>
          {t("This Actual budget tracks spending without envelopes, so assign your money after the move.")}
        </div>
      )}
    </div>
  );
}
