import { useEffect } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { isInstallable, useInstall } from "../lib/installPrompt";
import { Sheet } from "./chrome";
import { InstallBody } from "./InstallBody";

/**
 * Bottom sheet host for the adaptive install body. App is the SOLE owner/renderer (M7) —
 * both entry points (Drawer row, Settings hub card) open this one instance through App's
 * `installSheet` state; never render a second host.
 */
export function InstallSheet({ show, onClose }: { show: boolean; onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { state } = useInstall();

  // M5: `appinstalled` can fire while the sheet is open (e.g. Chrome's own omnibox install
  // button) — the state flips and InstallBody returns null, which would leave a heading over
  // an empty body. Close the host instead of showing empty chrome.
  useEffect(() => {
    if (show && !isInstallable(state)) onClose();
  }, [show, state, onClose]);

  return (
    <Sheet show={show} onClose={onClose}>
      <div style={{ padding: "6px 18px 22px" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 12 }}>{t("Add Enveo to your phone")}</div>
        <InstallBody onDone={onClose} />
      </div>
    </Sheet>
  );
}
