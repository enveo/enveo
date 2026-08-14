import { OPENAI_MODELS } from "@enveo/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { VaultMasterKeyProvider } from "../aiCredentials/keyProvider";
import {
  CredentialBudgetMismatch,
  CredentialNotConfigured,
  type CredentialOwner,
  CredentialVaultUnavailable,
  createCredentialRepository,
} from "../aiCredentials/repository";
import { requireTier, sessionUserId } from "../context";
import { type DbTransaction, db } from "../db/client";
import { openAiModelFetch, transportFailureJson } from "../openaiHttp";

const budgetId = z.string().uuid();
export const credentialBudgetInput = z.object({ budgetId }).strict();
export const credentialSaveInput = z.object({ budgetId, key: z.string().min(1).max(4096) }).strict();
export const credentialTestInput = z.object({ budgetId, model: z.enum(OPENAI_MODELS) }).strict();

export type CredentialUnavailableReason = "vault_unavailable";

export function publicCredentialStatus(configured: boolean, available: boolean, reason?: CredentialUnavailableReason) {
  return { configured, available, ...(reason ? { reason } : {}) };
}

export type ModelProbeResult = { ok: true } | { ok: false; code: "ai_key_invalid" | "ai_model_unavailable" | "ai_upstream_error"; status: 422 | 502 };
export type ModelProbe = (key: string, model: (typeof OPENAI_MODELS)[number]) => Promise<ModelProbeResult>;

async function defaultModelProbe(key: string, model: (typeof OPENAI_MODELS)[number]): Promise<ModelProbeResult> {
  const response = await openAiModelFetch(model, { apiKey: key });
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) return { ok: false, code: "ai_key_invalid", status: 422 };
  if (response.status === 404) return { ok: false, code: "ai_model_unavailable", status: 422 };
  return { ok: false, code: "ai_upstream_error", status: 502 };
}

type Variables = { userId?: string };

async function withClaimedPlainBudget<T>(
  c: Context<{ Variables: Variables }>,
  claimedBudgetId: string,
  work: (tx: DbTransaction, owner: CredentialOwner) => Promise<T>,
): Promise<T> {
  const userId = sessionUserId(c);
  if (!userId) throw new Error("unauthorized");
  return db.transaction(async (tx) => {
    const meta = await requireTier(c, "plain", tx);
    if (meta.id !== claimedBudgetId) throw new CredentialBudgetMismatch();
    return work(tx, { userId });
  });
}

function credentialError(c: Context, error: unknown): Response {
  if (error instanceof CredentialBudgetMismatch) return c.json({ error: error.code }, 409);
  if (error instanceof CredentialVaultUnavailable) return c.json({ error: error.code }, 503);
  if (error instanceof CredentialNotConfigured) return c.json({ error: error.code }, 409);
  throw error;
}

export function createAiCredentialRoutes(options: { masterKeys: VaultMasterKeyProvider | null; modelProbe?: ModelProbe }) {
  const routes = new Hono<{ Variables: Variables }>();
  const repository = createCredentialRepository(options.masterKeys);
  const modelProbe = options.modelProbe ?? defaultModelProbe;

  routes.get("/ai/credentials/openai/status", async (c) => {
    const input = credentialBudgetInput.parse(c.req.query());
    try {
      const status = await withClaimedPlainBudget(c, input.budgetId, (tx, owner) => repository.credentialStatus(tx, owner, input.budgetId));
      return c.json(publicCredentialStatus(status.configured, options.masterKeys !== null, options.masterKeys ? undefined : "vault_unavailable"));
    } catch (error) {
      return credentialError(c, error);
    }
  });

  routes.put("/ai/credentials/openai", async (c) => {
    const input = credentialSaveInput.parse(await c.req.json());
    try {
      await withClaimedPlainBudget(c, input.budgetId, (tx, owner) => repository.replaceServerCredential(tx, owner, input.budgetId, input.key));
      return c.json({ configured: true });
    } catch (error) {
      return credentialError(c, error);
    }
  });

  routes.delete("/ai/credentials/openai", async (c) => {
    const input = credentialBudgetInput.parse(await c.req.json());
    try {
      await withClaimedPlainBudget(c, input.budgetId, (tx, owner) => repository.deleteCredential(tx, owner, input.budgetId));
      return c.json({ configured: false });
    } catch (error) {
      return credentialError(c, error);
    }
  });

  routes.post("/ai/credentials/openai/test", async (c) => {
    const input = credentialTestInput.parse(await c.req.json());
    try {
      const result = await withClaimedPlainBudget(c, input.budgetId, (tx, owner) =>
        repository.withServerCredential(tx, owner, input.budgetId, (credential) => modelProbe(credential, input.model)),
      );
      if (!result.ok) return c.json({ error: result.code }, result.status);
      return c.json({ ok: true, model: input.model });
    } catch (error) {
      const transport = transportFailureJson(error);
      if (transport) return c.json(transport.body, transport.status);
      return credentialError(c, error);
    }
  });

  return routes;
}
