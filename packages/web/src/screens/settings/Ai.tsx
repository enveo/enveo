import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AI_MODEL_TIERS, costMultiplier, isLegacyOpenAiModel, LEGACY_OPENAI_MODELS, type ModelTier } from "../../lib/aiModelTiers";
import { api } from "../../lib/api";
import { OPENAI_MODELS, type OpenAiModel, useSettings, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { checkModelAvailability, type ModelAvailability } from "../../lib/openaiModels";
import { legacyCredentialMigration, readLegacyOpenAiCredential, setEphemeralOpenAiCredential } from "../../lib/settingsPersist";
import { CORAL, font, TEAL } from "../../lib/theme";
import { Helper, Row, Seg } from "./ui";

/**
 * AI provider and model are budget-scoped and synchronized. During the staged migration:
 *  - off:    suggestions computed locally on rules — zero egress,
 *  - server: requests via the app server (operator's key); when the server
 *            has no key (`/api/ai/info` → serverAi=false) we show a warning,
 *  - byok:   an existing legacy OpenAI key remains in a read-only quarantine until Stage 3,
 *            while calls still go straight to api.openai.com.
 *
 * BYOK model choice (§1b) is a quality/cost TIER picker over lib/aiModelTiers.ts, not raw model
 * ids; the id shows as secondary detail. With a key present the curated ids are validated against
 * `GET /v1/models` straight from the browser (debounced per key, cached only in query memory —
 * gcTime 0, never persisted): only a definite 200 verdict disables an option; an invalid key or
 * a failed check leaves every tier selectable and reports itself in one quiet status line.
 * A persisted legacy choice (gpt-5.5 / gpt-5.5-mini) renders as its own extra option — selected,
 * never silently rewritten — and stays offered until the end of the visit even after switching
 * to a tier, so an accidental tap is reversible.
 */
export function AiSection() {
  const C = useTheme();
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const [key, setKey] = useState(() => readLegacyOpenAiCredential()?.key ?? "");
  // Check server-mode availability only when it is selected (zero unnecessary requests).
  const { data: aiInfo } = useQuery({ queryKey: ["aiInfo"], queryFn: api.aiInfo, enabled: settings.aiMode === "server" });

  // BYOK availability probe: debounce the key so typing does not fire a request per keystroke.
  const trimmedKey = key.trim();
  const [settledKey, setSettledKey] = useState(trimmedKey);
  useEffect(() => {
    const id = setTimeout(() => setSettledKey(trimmedKey), 800);
    return () => clearTimeout(id);
  }, [trimmedKey]);
  const modelCheck = useQuery({
    queryKey: ["openaiModelAvailability", settledKey],
    queryFn: () => checkModelAvailability(settledKey, OPENAI_MODELS),
    enabled: settings.aiMode === "byok" && settledKey.length > 0,
    staleTime: 60_000,
    gcTime: 0, // transient by design — the verdict must not outlive the screen
    retry: false,
  });
  const avail: ModelAvailability | undefined = modelCheck.data;

  // The legacy option a user arrived with stays rendered for the whole visit (ref, not state):
  // switching to a tier must not make the way back disappear under the finger.
  const legacyAtMount = useRef<OpenAiModel | null>(isLegacyOpenAiModel(settings.openaiModel) ? settings.openaiModel : null);
  const legacyShown = LEGACY_OPENAI_MODELS.filter((m) => m === settings.openaiModel || m === legacyAtMount.current);

  const helper =
    settings.aiMode === "off"
      ? t("AI is off — suggestions run locally on rules; nothing leaves this device.")
      : settings.aiMode === "server"
        ? t("AI requests go to OpenAI through the app server (operator's key).")
        : t("The app talks to OpenAI directly from this browser using your own key — bypassing the server.");

  const unavailable = (model: OpenAiModel) => avail?.state === "checked" && !avail.available.has(model);
  const select = (model: OpenAiModel) => {
    setEphemeralOpenAiCredential(key, model);
    setSettings({ ...settings, openaiModel: model });
  };

  const option = (model: OpenAiModel, label: string, hint: string, tier?: ModelTier) => {
    const selected = settings.openaiModel === model;
    const off = unavailable(model);
    return (
      <button
        key={model}
        role="radio"
        aria-checked={selected}
        disabled={off && !selected}
        onClick={() => select(model)}
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
          opacity: off && !selected ? 0.55 : 1,
          cursor: off && !selected ? "default" : "pointer",
          fontFamily: font,
        }}
      >
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: selected ? TEAL : C.text }}>{label}</span>
          {tier && <span style={{ fontSize: 10.5, color: C.mute, whiteSpace: "nowrap" }}>{model}</span>}
        </span>
        <span style={{ fontSize: 11, color: C.mute, lineHeight: 1.45 }}>{hint}</span>
        {off && <span style={{ fontSize: 11, color: CORAL, lineHeight: 1.45 }}>{t("Not available with your OpenAI key.")}</span>}
      </button>
    );
  };

  return (
    <div style={{ marginTop: 4 }}>
      <Row label={t("Mode")}>
        <Seg
          value={settings.aiMode}
          onChange={(id) => setSettings({ ...settings, aiMode: id })}
          options={[
            { id: "off", label: t("Off") },
            { id: "server", label: t("Server") },
            { id: "byok", label: t("Own key") },
          ]}
        />
      </Row>
      <Helper>{helper}</Helper>

      {settings.aiMode === "server" && aiInfo && !aiInfo.serverAi && (
        <div style={{ fontSize: 12, color: CORAL, marginTop: 8, lineHeight: 1.5 }}>
          {t("The server has no OpenAI key configured — server mode is unavailable. Use your own key or keep AI off.")}
        </div>
      )}

      {settings.aiMode === "byok" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 6 }}>{t("OpenAI key")}</div>
          <input
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setEphemeralOpenAiCredential(e.target.value, settings.openaiModel);
            }}
            placeholder="sk-…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t("OpenAI key")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${C.line}`,
              background: C.bg,
              color: C.text,
              fontSize: 13,
              fontFamily: font,
            }}
          />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, margin: "14px 0 6px" }}>{t("Model")}</div>
          <div role="radiogroup" aria-label={t("Model")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {AI_MODEL_TIERS.map((tier) =>
              option(
                tier.model,
                t(tier.label),
                tier.id === "low"
                  ? t("Lowest cost — a typical screenshot import costs a fraction of a cent.")
                  : t("About {n}× the cost of the cheapest tier.", { n: costMultiplier(tier) }),
                tier,
              ),
            )}
            {legacyShown.map((m) => option(m, m, t("Previously selected model — it stays available until you pick a tier.")))}
          </div>
          {modelCheck.isFetching ? (
            <Helper>{t("Checking which models your key can use…")}</Helper>
          ) : avail?.state === "invalid_key" ? (
            <div style={{ fontSize: 11, color: CORAL, marginTop: 8, lineHeight: 1.5 }}>
              {t("OpenAI rejected this key — model availability could not be checked.")}
            </div>
          ) : avail?.state === "unknown" ? (
            <Helper>{t("Could not check model availability right now — every tier stays selectable.")}</Helper>
          ) : null}
          {import.meta.env.DEV && legacyCredentialMigration() === "pending-stage-3" && (
            <Helper>{t("An existing browser key is waiting for migration to the secure credential vault.")}</Helper>
          )}
          <Helper>{t("Existing browser credentials remain read-only until secure vault migration completes.")}</Helper>
        </div>
      )}
    </div>
  );
}
