import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSettings } from "../lib/contexts";
import { type Message, msg, useT } from "../lib/i18n";
import { readLegacyOpenAiCredential } from "../lib/settingsPersist";
import { TEAL } from "../lib/theme";
import { Sheet } from "./chrome";

/**
 * AI consent sheet — intercepts the FIRST use of an AI feature in off mode.
 * Shows exactly what will be sent to OpenAI (per-feature payload description)
 * and offers three ways out:
 *  - "Enable via server"  → aiMode="server" (only when /api/ai/info → serverAi=true),
 *  - an existing legacy key may still be selected while it awaits Stage-3 vault migration;
 *    this screen never accepts a new credential,
 *  - "Stay with rules" → does NOT change aiMode. Only the budget SUGGESTION has a rules
 *    engine to stay with; for the import (AI-only, no rules parser at all) the way out
 *    is "Cancel".
 * After the choice it calls `onDecided(mode)` — closing the sheet is the parent's job.
 */

export type AiFeature = "suggest" | "import";

const PAYLOAD_KEY: Record<AiFeature, Message> = {
  suggest: msg("The AI model (OpenAI) will receive: the amount to distribute, envelope names and aggregated spending stats from recent months."),
  import: msg("The AI model (OpenAI) will receive: the screenshots and the names of your envelopes and categories."),
};

export function AiConsentSheet({
  show,
  feature,
  onClose,
  onDecided,
}: {
  show: boolean;
  feature: AiFeature;
  onClose: () => void;
  onDecided: (mode: "server" | "byok" | "rules") => void;
}) {
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  // Server-mode availability is checked only when the sheet opens.
  const { data: aiInfo } = useQuery({ queryKey: ["aiInfo"], queryFn: api.aiInfo, enabled: show });
  const credential = readLegacyOpenAiCredential();

  const close = () => onClose();

  const chooseServer = () => {
    setSettings({ ...settings, aiMode: "server" });
    onDecided("server");
  };
  const chooseByok = () => {
    if (!credential) return;
    setSettings({ ...settings, aiMode: "byok", openaiModel: credential.model ?? settings.openaiModel });
    onDecided("byok");
  };

  return (
    <Sheet show={show} onClose={close}>
      {(C) => {
        const secondary = {
          width: "100%",
          padding: "12px 0",
          borderRadius: 12,
          border: `1px solid ${C.line}`,
          background: "transparent",
          color: C.text,
          fontSize: 13.5,
          fontWeight: 600,
          cursor: "pointer",
          marginBottom: 8,
        } as const;
        return (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("Enable AI assistance?")}</div>
            <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.5, marginBottom: 14 }}>{t(PAYLOAD_KEY[feature])}</div>

            {aiInfo?.serverAi && (
              <button
                onClick={chooseServer}
                style={{
                  width: "100%",
                  padding: "12px 0",
                  borderRadius: 12,
                  border: "none",
                  background: TEAL,
                  color: "#fff",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  marginBottom: 8,
                }}
              >
                {t("Enable via server")}
              </button>
            )}

            {credential ? (
              <button onClick={chooseByok} style={secondary}>
                {t("Use the existing own key")}
              </button>
            ) : (
              <div style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.5, marginBottom: 10 }}>
                {t("A new own key can be added after secure credential vault migration is available.")}
              </div>
            )}

            <button onClick={() => onDecided("rules")} style={{ ...secondary, marginBottom: 0 }}>
              {feature === "import" ? t("Cancel") : t("Stick with rules")}
            </button>
          </>
        );
      }}
    </Sheet>
  );
}
