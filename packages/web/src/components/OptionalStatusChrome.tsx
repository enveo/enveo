import { ImportActivityBadge } from "./ImportActivityBadge";
import { SyncActivityBadge } from "./SyncActivityBadge";
import { UpdatePrompt } from "./UpdatePrompt";

/** Optional shell status that may fail closed without hiding rejected writes/auth/ownership. */
export function OptionalStatusChrome({ showBadges, onOpenActivity }: { showBadges: boolean; onOpenActivity: () => void }) {
  return (
    <>
      {showBadges && <SyncActivityBadge />}
      {showBadges && <ImportActivityBadge onOpen={onOpenActivity} />}
      <UpdatePrompt />
    </>
  );
}
