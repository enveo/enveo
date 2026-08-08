import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { Sheet } from "./chrome";
import { InstallBody } from "./InstallBody";

/** Bottom sheet host for the adaptive install body (opened from Drawer / Settings). */
export function InstallSheet({ show, onClose }: { show: boolean; onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  return (
    <Sheet show={show} onClose={onClose}>
      <div style={{ padding: "6px 18px 22px" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 12 }}>{t("Add Enveo to your phone")}</div>
        <InstallBody onDone={onClose} />
      </div>
    </Sheet>
  );
}
