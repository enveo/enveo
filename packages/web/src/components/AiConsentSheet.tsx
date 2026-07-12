import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet } from "./chrome";
import { useSettings, type OpenAiModel } from "../lib/contexts";
import { useT, type TKey } from "../lib/i18n";
import { api } from "../lib/api";
import { TEAL, font } from "../lib/theme";

/**
 * AI consent sheet — intercepts the FIRST use of an AI feature in off mode.
 * Shows exactly what will be sent to OpenAI (per-feature payload description)
 * and offers three ways out:
 *  - "Enable via server"  → aiMode="server" (only when /api/ai/info → serverAi=true),
 *  - "Use your own key" → inline key + model → aiMode="byok" (key ONLY in localStorage),
 *  - "Stay with rules" → does NOT change aiMode (for import: "Cancel" — rules can't
 *    read screenshots, so this choice means aborting the import).
 * After the choice it calls `onDecided(mode)` — closing the sheet is the parent's job.
 */

export type AiFeature = "suggest" | "quickadd" | "import";

const PAYLOAD_KEY: Record<AiFeature, TKey> = {
  suggest: "ai.payload.suggest",
  quickadd: "ai.payload.quickadd",
  import: "ai.payload.import",
};

export function AiConsentSheet({ show, feature, onClose, onDecided }: {
  show: boolean;
  feature: AiFeature;
  onClose: () => void;
  onDecided: (mode: "server" | "byok" | "rules") => void;
}) {
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  // Server-mode availability is checked only when the sheet opens.
  const { data: aiInfo } = useQuery({ queryKey: ["aiInfo"], queryFn: api.aiInfo, enabled: show });
  const [byokOpen, setByokOpen] = useState(false);
  const [key, setKey] = useState(settings.openaiKey);
  const [model, setModel] = useState<OpenAiModel>(settings.openaiModel);

  const close = () => { setByokOpen(false); onClose(); };

  const chooseServer = () => {
    setSettings({ ...settings, aiMode: "server" });
    onDecided("server");
  };
  const chooseByok = () => {
    setSettings({ ...settings, aiMode: "byok", openaiKey: key.trim(), openaiModel: model });
    onDecided("byok");
  };

  return (
    <Sheet show={show} onClose={close}>
      {(C) => {
        const secondary = { width: "100%", padding: "12px 0", borderRadius: 12, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 8 } as const;
        return (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("ai.consentTitle")}</div>
            <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.5, marginBottom: 14 }}>{t(PAYLOAD_KEY[feature])}</div>

            {aiInfo?.serverAi && (
              <button onClick={chooseServer} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>
                {t("ai.consentServer")}
              </button>
            )}

            <button onClick={() => setByokOpen(!byokOpen)} style={{ ...secondary, borderColor: byokOpen ? TEAL : C.line, color: byokOpen ? TEAL : C.text }}>
              {t("ai.consentByok")}
            </button>
            {byokOpen && (
              <div style={{ padding: "2px 0 10px" }}>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={t("ai.key")}
                  style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font, outline: "none", marginBottom: 8 }}
                />
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  {(["gpt-5.5-mini", "gpt-5.5"] as const).map((m) => (
                    <button key={m} onClick={() => setModel(m)} style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: `1px solid ${model === m ? TEAL : C.line}`, background: model === m ? "var(--accent-1a)" : "transparent", color: model === m ? TEAL : C.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                      {m}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.5, marginBottom: 10 }}>{t("ai.keyLocal")}</div>
                <button onClick={chooseByok} disabled={!key.trim()} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: key.trim() ? 1 : 0.5 }}>
                  {t("ai.consentByokSave")}
                </button>
              </div>
            )}

            <button onClick={() => onDecided("rules")} style={{ ...secondary, marginBottom: 0 }}>
              {feature === "import" ? t("common.cancel") : t("ai.consentRules")}
            </button>
          </>
        );
      }}
    </Sheet>
  );
}
