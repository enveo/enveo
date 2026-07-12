import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSettings, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { CORAL, font } from "../../lib/theme";
import { Helper, Row, Seg } from "./ui";

/**
 * AI mode (a DEVICE setting, not synced):
 *  - off:    suggestions computed locally on rules — zero egress,
 *  - server: requests via the app server (operator's key); when the server
 *            has no key (`/api/ai/info` → serverAi=false) we show a warning,
 *  - byok:   user's own OpenAI key — lives ONLY in this browser's localStorage,
 *            calls go straight to api.openai.com (bypassing the server).
 */
export function AiSection() {
  const C = useTheme();
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  // Check server-mode availability only when it is selected (zero unnecessary requests).
  const { data: aiInfo } = useQuery({ queryKey: ["aiInfo"], queryFn: api.aiInfo, enabled: settings.aiMode === "server" });
  const helper =
    settings.aiMode === "off" ? t("ai.helpOff") : settings.aiMode === "server" ? t("ai.helpServer") : t("ai.helpByok");

  return (
    <div style={{ marginTop: 4 }}>
      <Row label={t("ai.mode")}>
        <Seg
          value={settings.aiMode}
          onChange={(id) => setSettings({ ...settings, aiMode: id })}
          options={[
            { id: "off", label: t("ai.off") },
            { id: "server", label: t("ai.server") },
            { id: "byok", label: t("ai.byok") },
          ]}
        />
      </Row>
      <Helper>{helper}</Helper>

      {settings.aiMode === "server" && aiInfo && !aiInfo.serverAi && (
        <div style={{ fontSize: 12, color: CORAL, marginTop: 8, lineHeight: 1.5 }}>{t("ai.serverUnavailable")}</div>
      )}

      {settings.aiMode === "byok" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 6 }}>{t("ai.key")}</div>
          <input
            type="password"
            value={settings.openaiKey}
            onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value.trim() })}
            placeholder="sk-…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t("ai.key")}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font, outline: "none" }}
          />
          <Row label={t("ai.model")}>
            <Seg
              value={settings.openaiModel}
              onChange={(id) => setSettings({ ...settings, openaiModel: id })}
              options={[
                { id: "gpt-5.5-mini", label: "gpt-5.5-mini" },
                { id: "gpt-5.5", label: "gpt-5.5" },
              ]}
            />
          </Row>
          <Helper>{t("ai.keyLocal")}</Helper>
        </div>
      )}
    </div>
  );
}
