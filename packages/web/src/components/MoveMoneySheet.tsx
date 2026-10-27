import { computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLedgerVersion } from "../lib/api";
import { useMask } from "../lib/contexts";
import { donorSlack } from "../lib/coverSources";
import { currentMonth } from "../lib/dates";
import { haptic } from "../lib/haptics";
import { useT } from "../lib/i18n";
import { store } from "../lib/store";
import { type CoverDelta, CoverStepSheet, revertCover } from "./CoverStepSheet";
import { UndoBar } from "./reportKit";

interface PendingUndo {
  id: string;
  amount: number;
  name: string;
  month: string;
  deltas: CoverDelta[];
}

const UNDO_TIMEOUT_MS = 6000;

/**
 * The envelope's own "Move": the Budgets checklist's cover sheet aimed at one envelope, with the
 * overspend (if any) as the proposal and otherwise no target amount. Stays mounted after the sheet
 * closes so its undo toast outlives it; the toast text is composed at render (discreet toggle).
 */
export function MoveMoneySheet({ target, onClose }: { target: { envelopeId: string; month: string } | null; onClose: () => void }) {
  const M = useMask();
  const { t } = useT();
  const version = useLedgerVersion();
  const [pending, setPending] = useState<PendingUndo[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const thisMonth = currentMonth();

  const data = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger || !target) return null;
    return { state: computeStateResponse(ledger, target.month), slack: donorSlack(ledger, target.month, thisMonth) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, target?.envelopeId, target?.month, thisMonth]);
  const env = data?.state.envelopes.find((e) => e.id === target?.envelopeId && !e.archived);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, []);

  const dismiss = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setPending((prev) => prev.filter((u) => u.id !== id));
  };

  return (
    <>
      <UndoBar
        pending={pending.map((p) => ({ ...p, message: t("Moved {amount} to {name}", { amount: M(p.amount), name: p.name }) }))}
        onUndo={(u) => {
          revertCover(u.month, u.deltas);
          haptic(8);
          dismiss(u.id);
        }}
        onDismiss={dismiss}
      />
      {data && env && (
        <CoverStepSheet
          key={`${env.id}:${data.state.month}`}
          state={data.state}
          step={{ envelopeId: env.id, name: env.name, kind: "move", amount: Math.max(0, -env.available) }}
          slack={data.slack}
          currentMonth={thisMonth}
          onClose={onClose}
          onApplied={(step, result) => {
            const id = crypto.randomUUID();
            timers.current.set(
              id,
              setTimeout(() => dismiss(id), UNDO_TIMEOUT_MS),
            );
            setPending((prev) => [...prev, { id, amount: result.moved, name: step.name, month: data.state.month, deltas: result.deltas }]);
          }}
        />
      )}
    </>
  );
}
