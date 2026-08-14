import { budgetSecretAadContext, encryptPayload } from "./crypto";

export type EnableCredentialAction = { kind: "none" } | { kind: "server-vault-to-e2ee"; ciphertext: string };

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
