import { budgetSecretAadContext, decryptPayload, type E2eeAadContext, encryptPayload } from "./crypto";

export type EnableCredentialAction = { kind: "none" } | { kind: "server-vault-to-e2ee"; ciphertext: string };
export type DisableCredentialAction = { kind: "none" } | { kind: "e2ee-to-server-vault"; key: string };

export async function prepareEnableCredentialAction(input: {
  configured: boolean;
  key: string;
  budgetId: string;
  nextEpoch: number;
  dek: Uint8Array;
}): Promise<EnableCredentialAction> {
  if (!input.configured) return { kind: "none" };
  const key = input.key.trim();
  if (!key) throw new Error("credential_reentry_required");
  return {
    kind: "server-vault-to-e2ee",
    ciphertext: await encryptPayload(key, input.dek, budgetSecretAadContext(input.budgetId, input.nextEpoch, "openai")),
  };
}

export async function prepareDisableCredentialAction(input: {
  record: { configured: boolean; budgetId: string; epoch: number; ciphertext?: string };
  budgetId: string;
  epoch: number;
  dek: Uint8Array;
}): Promise<DisableCredentialAction> {
  if (input.record.budgetId !== input.budgetId || input.record.epoch !== input.epoch) throw new Error("credential_epoch_mismatch");
  if (!input.record.configured) return { kind: "none" };
  if (!input.record.ciphertext) throw new Error("credential_bad_record");
  return {
    kind: "e2ee-to-server-vault",
    key: await decryptPayload(input.record.ciphertext, input.dek, budgetSecretAadContext(input.budgetId, input.epoch, "openai")),
  };
}

export async function reencryptBudgetSecret(input: {
  ciphertext: string;
  oldDek: Uint8Array;
  oldContext: E2eeAadContext;
  newDek: Uint8Array;
  newContext: E2eeAadContext;
}): Promise<string> {
  let plaintext = await decryptPayload(input.ciphertext, input.oldDek, input.oldContext);
  try {
    return await encryptPayload(plaintext, input.newDek, input.newContext);
  } finally {
    plaintext = "";
  }
}
