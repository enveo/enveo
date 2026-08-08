import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { useInstall } from "../lib/installPrompt";

const SHARE = "M12 4v11 M8.5 7.5L12 4l3.5 3.5 M6 11v7a2 2 0 002 2h8a2 2 0 002-2v-7";
const PLUS_BOX = "M12 8.5v7 M8.5 12h7 M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z";
const MARK = "\u0000";

/**
 * The adaptive install content, reused by the banner, the onboarding card and the
 * settings/drawer sheet. Renders nothing when there is nothing to offer.
 */
export function InstallBody({ onDone }: { onDone?: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { state, promptInstall } = useInstall();

  if (state === "installed" || state === "unavailable") return null;

  const step = (d: string, label: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, background: C.inset, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Ico d={d} size={18} color={C.soft} sw={1.7} />
      </span>
      <span style={{ fontSize: 13.5, color: C.text }}>{label}</span>
    </div>
  );

  if (state === "promptable") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13.5, color: C.soft, lineHeight: 1.45 }}>
          {t("Add Enveo to your device so it opens like any other app — offline, full screen, one tap away.")}
        </div>
        <button
          onClick={() => void promptInstall().finally(() => onDone?.())}
          style={{ width: "100%", padding: "13px 0", borderRadius: 12, border: "none", background: "var(--cta)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
        >
          {t("Install")}
        </button>
      </div>
    );
  }

  if (state === "ios-safari") {
    const share = t("Share");
    const addToHome = t("Add to Home Screen");

    const tapShareParts = t("Tap {action} to continue", { action: MARK }).split(MARK);
    const [tapShareBefore, tapShareAfter] = tapShareParts.length === 2 ? tapShareParts : [`${tapShareParts[0] ?? ""} `, ""];

    const thenAddParts = t("Then tap {action}", { action: MARK }).split(MARK);
    const [thenAddBefore, thenAddAfter] = thenAddParts.length === 2 ? thenAddParts : [`${thenAddParts[0] ?? ""} `, ""];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13.5, color: C.soft, lineHeight: 1.45 }}>
          {t("Add Enveo to your home screen so it opens like any other app:")}
        </div>
        {step(SHARE, <span>{tapShareBefore}<b>{share}</b>{tapShareAfter}</span>)}
        {step(PLUS_BOX, <span>{thenAddBefore}<b>{addToHome}</b>{thenAddAfter}</span>)}
      </div>
    );
  }

  // ios-other
  return (
    <div style={{ fontSize: 13.5, color: C.soft, lineHeight: 1.45 }}>
      {t("Open enveo.app in Safari to add it to your home screen — installing only works from Safari on iPhone and iPad.")}
    </div>
  );
}
