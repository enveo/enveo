import { useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import { accountFormPayload, canConfigureAutomaticEnvelope, selectableAutomaticEnvelopes } from "../lib/automaticEnvelopeAccountUi";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { ACCOUNT_COLORS, font, TEAL } from "../lib/theme";
import { EnvelopePickerSheet } from "../screens/add/EnvelopePickerSheet";
import { Surface } from "./chrome";
import { IconColorPicker } from "./IconColorPicker";

/**
 * PR6b Task 5 — `AccountEdit` + `AutomaticEnvelopeControl`, moved VERBATIM out of
 * `screens/Accounts.tsx` (the pr6-context "acctForm as pane surfaces" extraction): name input,
 * `IconColorPicker`, the `canConfigureAutomaticEnvelope`-gated `AutomaticEnvelopeControl` (toggle
 * + both explanatory lines + the picker row), the archived toggle + `window.confirm` copy, and
 * the `accountFormPayload` save all ship byte-identical. The ONLY edit is the hosting primitive:
 * `Sheet` → `Surface` — phone (and any un-hosted mount) renders `Sheet`, byte-identical; wide
 * renders a pane surface. Exported so both Accounts.tsx call sites (row edits AND, via
 * `AutomaticEnvelopeControl` alone, the "New account" sheet) and `AccountPanel`'s Edit action
 * (`components/wide/AccountPanel.tsx`) share one module instead of three copies.
 */
export function AccountEditSheet({
  account,
  envelopes,
  groups,
  onClose,
}: {
  account: StateResponse["accounts"][number] | null;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onClose: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [icon, setIcon] = useState("wallet");
  const [archived, setArchived] = useState(false);
  const [automaticEnvelopeId, setAutomaticEnvelopeId] = useState<string | null>(null);
  const [automaticPicker, setAutomaticPicker] = useState(false);
  useEffect(() => {
    if (account) {
      setName(account.name);
      setColor(account.color);
      setIcon(account.icon);
      setArchived(account.archived);
      setAutomaticEnvelopeId(
        selectableAutomaticEnvelopes(envelopes).some((envelope) => envelope.id === account.automaticEnvelopeId) ? account.automaticEnvelopeId : null,
      );
      setAutomaticPicker(false);
    }
  }, [account]);
  useEffect(() => {
    if (automaticEnvelopeId && !selectableAutomaticEnvelopes(envelopes).some((envelope) => envelope.id === automaticEnvelopeId)) {
      setAutomaticEnvelopeId(null);
    }
  }, [automaticEnvelopeId, envelopes]);
  if (!account) return null;
  const automaticEnvelopeName = selectableAutomaticEnvelopes(envelopes).find((envelope) => envelope.id === automaticEnvelopeId)?.name ?? null;
  const close = () => {
    setAutomaticPicker(false);
    onClose();
  };
  const save = () => {
    const nm = name.trim();
    if (!nm) return;
    if (archived && !account.archived) {
      const ok = window.confirm(
        t(
          "The account “{name}” will disappear from the Start screen and lists (you will find it under “Closed” on the Accounts screen). Its transactions and balance still count in the budget and reports.\n\nArchive it?",
          { name: nm },
        ),
      );
      if (!ok) return;
    }
    local.updateAccount(
      account.id,
      accountFormPayload({
        name: nm,
        color,
        icon,
        onBudget: account.onBudget,
        automaticEnvelopeId,
        archived,
      }),
    );
    close();
  };
  return (
    <>
      <Surface show={!!account} onClose={close}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("Edit account")}</div>
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {t("Account name")}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 0",
                border: "none",
                borderBottom: `1px solid ${C.line}`,
                background: "none",
                color: C.text,
                fontSize: 15,
                fontFamily: font,
                marginBottom: 18,
                boxSizing: "border-box",
              }}
            />
            <IconColorPicker palette={ACCOUNT_COLORS} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
            {canConfigureAutomaticEnvelope(account) && (
              <AutomaticEnvelopeControl
                enabled={automaticEnvelopeId !== null}
                envelopeName={automaticEnvelopeName}
                onToggle={() => (automaticEnvelopeId ? setAutomaticEnvelopeId(null) : setAutomaticPicker(true))}
                onPick={() => setAutomaticPicker(true)}
              />
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <span style={{ fontSize: 14, color: C.text }}>{t("Archived account")}</span>
              <button
                onClick={() => setArchived(!archived)}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  background: archived ? TEAL : C.line,
                  position: "relative",
                  border: "none",
                  cursor: "pointer",
                  transition: "background .2s",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#fff",
                    position: "absolute",
                    top: 2,
                    left: archived ? 20 : 2,
                    transition: "left .2s",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                />
              </button>
            </div>
            <button
              onClick={save}
              disabled={!name.trim()}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 11,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                opacity: name.trim() ? 1 : 0.4,
              }}
            >
              {t("Save")}
            </button>
          </>
        )}
      </Surface>
      <EnvelopePickerSheet
        show={automaticPicker}
        onClose={() => setAutomaticPicker(false)}
        envelopes={envelopes}
        groups={groups}
        onSelect={(id) => {
          setAutomaticEnvelopeId(id);
          setAutomaticPicker(false);
        }}
      />
    </>
  );
}

export function AutomaticEnvelopeControl({
  enabled,
  envelopeName,
  onToggle,
  onPick,
}: {
  enabled: boolean;
  envelopeName: string | null;
  onToggle: () => void;
  onPick: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 14, color: C.text }}>{t("Automatic envelope")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("Automatic envelope")}
          onClick={onToggle}
          style={{
            width: 42,
            height: 24,
            borderRadius: 12,
            background: enabled ? TEAL : C.line,
            position: "relative",
            border: "none",
            cursor: "pointer",
            transition: "background .2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              top: 2,
              left: enabled ? 20 : 2,
              transition: "left .2s",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }}
          />
        </button>
      </div>
      <div style={{ color: C.mute, fontSize: 11.5, lineHeight: 1.45, marginTop: 6 }}>
        {t("Income and transfers to this account increase the selected envelope. Transfers from this account decrease it.")}
      </div>
      <div style={{ color: C.mute, fontSize: 11.5, lineHeight: 1.45, marginTop: 6 }}>
        {t("The link works from now on. The current account balance and envelope amount will not change.")}
      </div>
      {enabled && envelopeName && (
        <button
          type="button"
          onClick={onPick}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            padding: "9px 10px",
            borderRadius: 9,
            border: `1px solid ${C.line}`,
            background: C.bg,
            color: C.text,
            fontSize: 13,
            fontFamily: font,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{envelopeName}</span>
          <Ico d="M9 18l6-6-6-6" size={15} color={C.mute} />
        </button>
      )}
    </div>
  );
}
