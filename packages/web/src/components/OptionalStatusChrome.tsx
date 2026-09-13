import { SyncActivityBadge } from "./SyncActivityBadge";
import { UpdatePrompt } from "./UpdatePrompt";

/** Optional shell status that may fail closed without hiding rejected writes/auth/ownership. */
export function OptionalStatusChrome({ showBadges }: { showBadges: boolean }) {
  return (
    <>
      {showBadges && (
        <div
          data-header-status-group="true"
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top) + 12px)",
            right: 48,
            zIndex: 61,
            height: 29,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <SyncActivityBadge />
        </div>
      )}
      <UpdatePrompt />
    </>
  );
}
