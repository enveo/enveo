import { accountIconColor } from "../components/tiles";
import { Glyph } from "../lib/icons";

interface AccountListRowContentProps {
  account: { name: string; color: string; icon: string; balance: number };
  automaticLabel: string | null;
  balanceText: string;
  compact?: boolean;
  colors: { text: string; soft: string; mute: string };
}

/** Shared shrink/ellipsis contract for active and closed account rows. */
export function AccountListRowContent({ account, automaticLabel, balanceText, compact = false, colors }: AccountListRowContentProps) {
  const iconBox = compact ? 34 : 44;
  const iconDisc = compact ? 24 : 30;
  return (
    <div
      data-account-row-content={compact ? "closed" : "active"}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
        <div
          style={{
            width: iconBox,
            height: iconBox,
            borderRadius: compact ? 10 : 12,
            background: account.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: iconDisc,
              height: iconDisc,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.92)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Glyph name={account.icon} size={compact ? 13 : 16} color={accountIconColor(account.color)} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: compact ? colors.soft : colors.text,
              fontSize: compact ? 13.5 : 14.5,
              fontWeight: compact ? undefined : 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {account.name}
          </div>
          {automaticLabel && (
            <div style={{ color: colors.mute, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
              {automaticLabel}
            </div>
          )}
        </div>
      </div>
      <span
        style={{
          fontSize: compact ? 13 : 15,
          fontWeight: compact ? undefined : 600,
          color: compact || account.balance === 0 ? colors.mute : colors.text,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
          marginLeft: 8,
        }}
      >
        {balanceText}
      </span>
    </div>
  );
}
