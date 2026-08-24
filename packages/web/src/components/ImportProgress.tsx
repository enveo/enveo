import type { ImportJobErrorCode, ImportJobPhase } from "@enveo/shared";
import { useTheme } from "../lib/contexts";
import { type Message, msg, useT } from "../lib/i18n";
import type { StorageMode } from "../lib/idb";
import type { ImportActivityItem } from "../lib/importJobs/store";
import { CORAL, TEAL } from "../lib/theme";

const PHASE_MESSAGES: Record<ImportJobPhase, Message> = {
  preparing: msg("Preparing screenshots…"),
  uploading: msg("Uploading screenshots…"),
  queued: msg("Waiting to start…"),
  extracting: msg("Reading transactions…"),
  validating: msg("Checking recognized data…"),
  enriching: msg("Matching your budget…"),
  reconciling: msg("Checking the current ledger…"),
  ready: msg("Ready to review"),
  applying: msg("Adding transactions…"),
  completed: msg("Import completed"),
  waiting_for_network: msg("Waiting for a network connection…"),
  waiting_for_device: msg("Waiting for this device…"),
  waiting_for_unlock: msg("Waiting for this budget to be unlocked…"),
  retry_scheduled: msg("A retry is scheduled…"),
};

const ERROR_MESSAGES: Record<ImportJobErrorCode, Message> = {
  network: msg("The import could not reach the AI service. Try again when the connection is stable."),
  ai_timeout: msg("The AI service took too long to answer. You can retry this import."),
  ai_budget_exhausted: msg("The monthly Enveo AI allowance is used up. Try again next month or choose Own OpenAI."),
  ai_key_invalid: msg("The saved OpenAI key was rejected. Update the key before retrying."),
  ai_model_unavailable: msg("The selected AI model is unavailable. Choose another model before retrying."),
  malformed_model_response: msg("The AI answer could not be validated. Retry the import or choose another model."),
  budget_mismatch: msg("The signed-in account changed. Reload the app before retrying this import."),
  tier_mismatch: msg("The budget encryption mode changed. Start a new import."),
  account_unavailable: msg("The source account is no longer available. Start a new import with another account."),
  expired: msg("This import expired. Start a new import from the screenshots."),
};

export interface ImportProgressPresentation {
  kind: "progress" | "review" | "failed" | "completed";
  message: Message;
  canContinueInBackground: boolean;
  canCancel: boolean;
}

export function importProgressPresentation(item: ImportActivityItem): ImportProgressPresentation {
  if (item.status === "ready") return { kind: "review", message: PHASE_MESSAGES.ready, canContinueInBackground: false, canCancel: false };
  if (item.status === "completed") return { kind: "completed", message: PHASE_MESSAGES.completed, canContinueInBackground: false, canCancel: false };
  if (item.status === "failed") {
    return {
      kind: "failed",
      message: item.errorCode ? ERROR_MESSAGES[item.errorCode] : msg("The import failed. You can retry it from Activity."),
      canContinueInBackground: false,
      canCancel: false,
    };
  }
  return { kind: "progress", message: PHASE_MESSAGES[item.phase], canContinueInBackground: true, canCancel: true };
}

export async function runImportProgressAction(
  action: "background" | "cancel",
  deps: { jobId: string; close(): void; cancel(id: string): Promise<void> },
): Promise<void> {
  if (action === "cancel") await deps.cancel(deps.jobId);
  deps.close();
}

export function sharedDeviceImportWarning(tier: "plain" | "e2ee", storage: StorageMode): Message | null {
  return tier === "e2ee" && storage === "memory-session"
    ? msg("This import runs directly between this device and OpenAI. On a shared device it cannot survive closing or reloading the app.")
    : null;
}

export function ImportProgress({
  item,
  onBackground,
  onCancel,
  showBackground = true,
}: {
  item: ImportActivityItem;
  onBackground: () => void;
  onCancel: () => void;
  showBackground?: boolean;
}) {
  const C = useTheme();
  const { t } = useT();
  const presentation = importProgressPresentation(item);
  return (
    <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "16px 0 4px" }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: `2px solid ${C.line}`,
          borderTopColor: TEAL,
          animation: "sp .7s linear infinite",
        }}
      />
      <div style={{ marginTop: 12, color: C.text, fontSize: 16, fontWeight: 700 }}>{t(presentation.message)}</div>
      <div style={{ marginTop: 5, color: C.mute, fontSize: 12 }}>{t("You can leave this view. The import will stay in Activity.")}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            flex: 1,
            padding: "11px 8px",
            borderRadius: 12,
            border: `1px solid ${C.line}`,
            background: C.bg,
            color: CORAL,
            fontWeight: 650,
            cursor: "pointer",
          }}
        >
          {t("Cancel import")}
        </button>
        {showBackground && (
          <button
            type="button"
            onClick={onBackground}
            style={{ flex: 1.5, padding: "11px 8px", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontWeight: 650, cursor: "pointer" }}
          >
            {t("Continue in background")}
          </button>
        )}
      </div>
    </div>
  );
}
