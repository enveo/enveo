import { describe, expect, it } from "bun:test";
import { budgetSecretAadContext, decryptPayload, encryptPayload, generateDek } from "./crypto";
import { prepareDisableCredentialAction, prepareEnableCredentialAction, reencryptBudgetSecret } from "./e2eeCredentialCeremonies";

const BUDGET = "11111111-1111-1111-1111-111111111111";

describe("E2EE credential ceremony", () => {
  it("uses an explicit no-op when plain BYOK is not configured", async () => {
    const action = await prepareEnableCredentialAction({ configured: false, key: "", budgetId: BUDGET, nextEpoch: 4, dek: generateDek() });

    expect(action).toEqual({ kind: "none" });
  });

  it("requires re-entry and encrypts configured BYOK for the new budget epoch", async () => {
    const dek = generateDek();

    await expect(prepareEnableCredentialAction({ configured: true, key: "", budgetId: BUDGET, nextEpoch: 4, dek })).rejects.toThrow(
      "credential_reentry_required",
    );
    const action = await prepareEnableCredentialAction({ configured: true, key: "sk-move-me", budgetId: BUDGET, nextEpoch: 4, dek });

    expect(action.kind).toBe("server-vault-to-e2ee");
    if (action.kind !== "server-vault-to-e2ee") throw new Error("wrong_action");
    expect(await decryptPayload(action.ciphertext, dek, budgetSecretAadContext(BUDGET, 4, "openai"))).toBe("sk-move-me");
  });

  it("decrypts E2EE BYOK only for the matching budget epoch before disabling", async () => {
    const dek = generateDek();
    const ciphertext = await encryptPayload("sk-return-to-vault", dek, budgetSecretAadContext(BUDGET, 4, "openai"));

    expect(await prepareDisableCredentialAction({ record: { configured: false, budgetId: BUDGET, epoch: 4 }, budgetId: BUDGET, epoch: 4, dek })).toEqual({
      kind: "none",
    });
    expect(
      await prepareDisableCredentialAction({ record: { configured: true, budgetId: BUDGET, epoch: 4, ciphertext }, budgetId: BUDGET, epoch: 4, dek }),
    ).toEqual({ kind: "e2ee-to-server-vault", key: "sk-return-to-vault" });
    await expect(
      prepareDisableCredentialAction({ record: { configured: true, budgetId: BUDGET, epoch: 3, ciphertext }, budgetId: BUDGET, epoch: 4, dek }),
    ).rejects.toThrow("credential_epoch_mismatch");
  });

  it("re-encrypts a budget secret under a fresh DEK and authenticated next-epoch context", async () => {
    const oldDek = generateDek();
    const newDek = generateDek();
    const oldContext = budgetSecretAadContext(BUDGET, 4, "openai");
    const newContext = budgetSecretAadContext(BUDGET, 5, "openai");
    const oldCiphertext = await encryptPayload("sk-rotate", oldDek, oldContext);

    const rotated = await reencryptBudgetSecret({ ciphertext: oldCiphertext, oldDek, oldContext, newDek, newContext });

    expect(rotated).not.toBe(oldCiphertext);
    expect(await decryptPayload(rotated, newDek, newContext)).toBe("sk-rotate");
    await expect(reencryptBudgetSecret({ ciphertext: oldCiphertext, oldDek: generateDek(), oldContext, newDek, newContext })).rejects.toThrow();
    await expect(reencryptBudgetSecret({ ciphertext: "v1.legacy", oldDek, oldContext, newDek, newContext })).rejects.toThrow("legacy_ciphertext");
  });
});
