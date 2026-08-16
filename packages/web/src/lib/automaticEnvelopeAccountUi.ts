import type { AccountPayload } from "@enveo/shared";

type AutomaticEnvelopeOption = {
  id: string;
  name: string;
  archived: boolean;
  isSavings: boolean;
};

type AutomaticEnvelopeAccount = {
  name: string;
  onBudget: boolean;
  archived: boolean;
  automaticEnvelopeId: string | null;
};

export type AccountFormFields = {
  name: string;
  color: string;
  icon: string;
  onBudget: boolean;
  automaticEnvelopeId: string | null;
  initialBalance?: number;
  archived?: boolean;
  sort?: number;
};

export function selectableAutomaticEnvelopes<T extends AutomaticEnvelopeOption>(envelopes: T[]): T[] {
  return envelopes.filter((envelope) => !envelope.archived);
}

export function canConfigureAutomaticEnvelope(account: Pick<AutomaticEnvelopeAccount, "onBudget">): boolean {
  return account.onBudget;
}

export function linkedAccountNames(accounts: AutomaticEnvelopeAccount[], envelopeId: string): string[] {
  return accounts.filter((account) => account.automaticEnvelopeId === envelopeId).map((account) => account.name);
}

export function visibleAutomaticEnvelopeName(account: AutomaticEnvelopeAccount, envelopes: AutomaticEnvelopeOption[]): string | null {
  if (!canConfigureAutomaticEnvelope(account) || !account.automaticEnvelopeId) return null;
  return selectableAutomaticEnvelopes(envelopes).find((envelope) => envelope.id === account.automaticEnvelopeId)?.name ?? null;
}

export function accountFormPayload(fields: AccountFormFields): AccountPayload {
  return {
    ...fields,
    automaticEnvelopeId: fields.onBudget ? fields.automaticEnvelopeId : null,
  };
}
