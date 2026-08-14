import type { OpenAiModel } from "@enveo/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AI_MODEL_TIERS, costMultiplier, isLegacyOpenAiModel, LEGACY_OPENAI_MODELS, type ModelTier } from "../../lib/aiModelTiers";
import type { AiProviderKind } from "../../lib/aiProvider/contracts";
import { useAiProvider } from "../../lib/aiProvider/useAiProvider";
import { apiErrorMessage } from "../../lib/api";
import { useBudgetPreferences, useTheme } from "../../lib/contexts";
import * as e2ee from "../../lib/e2ee";
import { type Message, msg, useT } from "../../lib/i18n";
import { CORAL, font, TEAL } from "../../lib/theme";
import { Eyebrow, Helper, Row, Seg } from "./ui";

type ActionState = "idle" | "saving" | "testing" | "deleting";

const STATUS_COPY: Record<"ready" | "not-configured" | "operator-unavailable" | "tier-unavailable" | "locked" | "vault-unavailable", Message> = {
  ready: msg("Ready to use."),
  "not-configured": msg("No OpenAI key is configured."),
  "operator-unavailable": msg("The server operator has not enabled Enveo AI."),
  "tier-unavailable": msg("This provider is unavailable for an end-to-end encrypted budget."),
  locked: msg("Unlock the budget to use this provider."),
  "vault-unavailable": msg("The server credential vault is not configured."),
};

/** Budget-scoped AI preferences. The only plaintext-key boundary is the save
 * action below; after acknowledgement the input is cleared and no read API
 * exists. */
export function AiSection() {
  const C = useTheme();
  const { t } = useT();
  const { preferences, update } = useBudgetPreferences();
  const provider = useAiProvider();
  const tier = e2ee.getTierMeta().tier;
  const [key, setKey] = useState("");
  const [action, setAction] = useState<ActionState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: ["aiProviderStatus", tier, preferences.aiProvider, preferences.openaiModel],
    queryFn: () => provider.status(),
    retry: false,
  });
  const status = statusQuery.data;

  const legacyAtMount = useRef<OpenAiModel | null>(isLegacyOpenAiModel(preferences.openaiModel) ? preferences.openaiModel : null);
  const legacyShown = LEGACY_OPENAI_MODELS.filter((model) => model === preferences.openaiModel || model === legacyAtMount.current);

  const selectProvider = (selected: "rules" | "enveo" | "openai") => {
    setActionError(null);
    setActionOk(null);
    update({ aiProvider: selected });
  };

  const runAction = async (next: Exclude<ActionState, "idle">, work: () => Promise<void>, success: string) => {
    setAction(next);
    setActionError(null);
    setActionOk(null);
    try {
      await work();
      setActionOk(success);
      await statusQuery.refetch();
    } catch (error) {
      setActionError(apiErrorMessage(error));
    } finally {
      setAction("idle");
    }
  };

  const save = () => {
    const value = key.trim();
    if (!value) return;
    void runAction(
      "saving",
      async () => {
        await provider.saveCredential(value);
        setKey("");
      },
      t("OpenAI key saved securely."),
    );
  };

  const remove = () => void runAction("deleting", () => provider.removeCredential(), t("OpenAI key removed."));
  const test = () => void runAction("testing", () => provider.testConnection(), t("Connection successful."));

  const selectModel = (model: OpenAiModel) => update({ openaiModel: model });
  const option = (model: OpenAiModel, label: string, hint: string, modelTier?: ModelTier) => {
    const selected = preferences.openaiModel === model;
    return (
      <button
        key={model}
        role="radio"
        aria-checked={selected}
        onClick={() => selectModel(model)}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 3,
          textAlign: "left",
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${selected ? TEAL : C.line}`,
          background: selected ? "var(--accent-1a)" : "transparent",
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: selected ? TEAL : C.text }}>{label}</span>
          {modelTier && <span style={{ fontSize: 10.5, color: C.mute, whiteSpace: "nowrap" }}>{model}</span>}
        </span>
        <span style={{ fontSize: 11, color: C.mute, lineHeight: 1.45 }}>{hint}</span>
      </button>
    );
  };

  const flow =
    preferences.aiProvider === "rules"
      ? t("Suggestions are calculated on this device. No data is sent to an AI service.")
      : preferences.aiProvider === "enveo"
        ? t("Enveo sends the required prompt or screenshots to OpenAI using the server operator's key.")
        : tier === "plain"
          ? t("Your browser calls Enveo; Enveo decrypts your key only for the request and calls OpenAI. The key is never returned to a device.")
          : t("Own OpenAI for end-to-end encrypted budgets will require the zero-knowledge vault.");

  return (
    <div style={{ marginTop: 4 }}>
      <Eyebrow>{t("Budget preferences")}</Eyebrow>
      <Helper>{t("The AI provider, model and custom profiles follow this budget on every device.")}</Helper>
      <Row label={t("Provider")}>
        <Seg
          value={preferences.aiProvider}
          onChange={(id) => selectProvider(id as AiProviderKind)}
          options={[
            { id: "rules", label: t("Without AI") },
            { id: "enveo", label: t("Enveo AI") },
            { id: "openai", label: t("Own OpenAI") },
          ]}
        />
      </Row>
      <Helper>{flow}</Helper>

      {status && status.code !== "ready" && <div style={{ fontSize: 12, color: CORAL, marginTop: 8, lineHeight: 1.5 }}>{t(STATUS_COPY[status.code])}</div>}

      {preferences.aiProvider === "openai" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 6 }}>{t("OpenAI key")}</div>
          <Helper>
            {status?.configured
              ? t("A key is stored in the server vault. Enveo cannot display it; saving below replaces it atomically.")
              : t("Paste the key once. Enveo stores only an envelope-encrypted credential and never returns it.")}
          </Helper>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={status?.configured ? t("New key (replaces current)") : t("OpenAI API key")}
              autoComplete="off"
              spellCheck={false}
              disabled={tier !== "plain" || status?.code === "vault-unavailable" || action !== "idle"}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "10px 11px",
                borderRadius: 10,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.text,
                fontFamily: font,
              }}
            />
            <button
              onClick={save}
              disabled={!key.trim() || tier !== "plain" || action !== "idle"}
              style={{
                padding: "0 14px",
                borderRadius: 10,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontWeight: 600,
                opacity: !key.trim() || action !== "idle" ? 0.5 : 1,
              }}
            >
              {action === "saving" ? t("Saving…") : t("Save")}
            </button>
          </div>
          {status?.configured && tier === "plain" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={test}
                disabled={action !== "idle"}
                style={{ flex: 1, padding: "10px", borderRadius: 10, border: `1px solid ${C.line}`, background: "transparent", color: C.text }}
              >
                {action === "testing" ? t("Testing…") : t("Test connection")}
              </button>
              <button
                onClick={remove}
                disabled={action !== "idle"}
                style={{ flex: 1, padding: "10px", borderRadius: 10, border: `1px solid ${CORAL}`, background: "transparent", color: CORAL }}
              >
                {action === "deleting" ? t("Removing…") : t("Remove key")}
              </button>
            </div>
          )}
          {actionOk && <div style={{ fontSize: 11.5, color: C.pos, marginTop: 8 }}>{actionOk}</div>}
          {actionError && <div style={{ fontSize: 11.5, color: CORAL, marginTop: 8 }}>{actionError}</div>}

          <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, margin: "16px 0 6px" }}>{t("Model")}</div>
          <div role="radiogroup" aria-label={t("Model")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {AI_MODEL_TIERS.map((modelTier) =>
              option(
                modelTier.model,
                t(modelTier.label),
                modelTier.id === "low"
                  ? t("Lowest cost — a typical screenshot import costs a fraction of a cent.")
                  : t("About {n}× the cost of the cheapest tier.", { n: costMultiplier(modelTier) }),
                modelTier,
              ),
            )}
            {legacyShown.map((model) => option(model, model, t("Previously selected model — it stays available until you pick a tier.")))}
          </div>
        </div>
      )}

      <Helper>{t("Custom suggestion profiles configured for this budget: {n}.", { n: preferences.customProfiles.length })}</Helper>
    </div>
  );
}
