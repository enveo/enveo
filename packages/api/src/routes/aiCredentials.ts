import { aiLocaleSchema, type ChatRequest, OPENAI_MODELS } from "@enveo/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { VaultMasterKeyProvider } from "../aiCredentials/keyProvider";
import {
  CredentialBudgetMismatch,
  CredentialE2eeUpgradeRequired,
  CredentialNotConfigured,
  type CredentialOwner,
  CredentialVaultUnavailable,
  createCredentialRepository,
} from "../aiCredentials/repository";
import { ByokInvalidBodyError, ByokUpstreamError, byokChatContent } from "../aiCredentials/transport";
import { requireTier, sessionUserId } from "../context";
import { type DbTransaction, db } from "../db/client";
import { openAiModelFetch, transportFailureJson } from "../openaiHttp";
import { extractImportForBudget, ImportCycleOneFailure } from "./import";

const budgetId = z.string().uuid();
export const credentialBudgetInput = z.object({ budgetId }).strict();
export const credentialSaveInput = z.object({ budgetId, key: z.string().min(1).max(4096) }).strict();
export const credentialTestInput = z.object({ budgetId, model: z.enum(OPENAI_MODELS) }).strict();
const e2eeCiphertext = z
  .string()
  .min(4)
  .max(8192)
  .regex(/^v2\.[A-Za-z0-9+/]+={0,2}$/);
export const e2eeCredentialSaveInput = z.object({ budgetId, expectedEpoch: z.number().int().nonnegative(), ciphertext: e2eeCiphertext }).strict();
export const e2eeCredentialDeleteInput = z.object({ budgetId, expectedEpoch: z.number().int().nonnegative() }).strict();
const chatMessage = z
  .object({
    role: z.enum(["system", "user"]),
    content: z.union([z.string().max(200_000), z.array(z.record(z.string(), z.unknown())).max(20)]),
  })
  .strict();
export const byokChatInput = z
  .object({
    budgetId,
    model: z.enum(OPENAI_MODELS),
    messages: z.array(chatMessage).min(1).max(4),
    responseFormat: z.record(z.string(), z.unknown()).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();
export const byokImportInput = z
  .object({
    budgetId,
    accountId: z.string().uuid(),
    model: z.enum(OPENAI_MODELS),
    images: z
      .array(z.string().regex(/^data:image\//, "expected an image data-URL"))
      .min(1)
      .max(6),
    locale: aiLocaleSchema.optional(),
  })
  .strict();

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

async function withClaimedBudget<T>(c: Context<{ Variables: Variables }>, work: (tx: DbTransaction, owner: CredentialOwner) => Promise<T>): Promise<T> {
  const userId = sessionUserId(c);
  if (!userId) throw new Error("unauthorized");
  return db.transaction((tx) => work(tx, { userId }));
}

function credentialError(c: Context, error: unknown): Response {
  if (error instanceof CredentialBudgetMismatch) return c.json({ error: error.code }, 409);
  if (error instanceof CredentialE2eeUpgradeRequired) {
    return c.json({ error: error.code, tier: error.meta.tier, epoch: error.meta.epoch, cipherVersion: error.meta.cipherVersion, budgetId: error.meta.id }, 409);
  }
  if (error instanceof CredentialVaultUnavailable) return c.json({ error: error.code }, 503);
  if (error instanceof CredentialNotConfigured) return c.json({ error: error.code }, 409);
  throw error;
}

function byokFailure(c: Context, error: unknown): Response {
  const transport = transportFailureJson(error);
  if (transport) return c.json(transport.body, transport.status);
  if (error instanceof ByokUpstreamError) {
    if (error.status === 401 || error.status === 403) return c.json({ error: "ai_key_invalid" }, 422);
    return c.json({ error: "ai_upstream_error", status: error.status }, 502);
  }
  if (error instanceof ByokInvalidBodyError) return c.json({ error: "ai_upstream_error" }, 502);
  return credentialError(c, error);
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

  routes.get("/ai/credentials/openai/e2ee", async (c) => {
    const input = credentialBudgetInput.parse(c.req.query());
    try {
      const result = await withClaimedBudget(c, (tx, owner) => repository.e2eeCredential(tx, owner, input.budgetId));
      return c.json(result);
    } catch (error) {
      return credentialError(c, error);
    }
  });

  routes.put("/ai/credentials/openai/e2ee", async (c) => {
    const input = e2eeCredentialSaveInput.parse(await c.req.json());
    try {
      const epoch = await withClaimedBudget(c, (tx, owner) =>
        repository.replaceE2eeCredential(tx, owner, input.budgetId, input.expectedEpoch, input.ciphertext),
      );
      return c.json({ configured: true, budgetId: input.budgetId, epoch });
    } catch (error) {
      return credentialError(c, error);
    }
  });

  routes.delete("/ai/credentials/openai/e2ee", async (c) => {
    const input = e2eeCredentialDeleteInput.parse(await c.req.json());
    try {
      const epoch = await withClaimedBudget(c, (tx, owner) => repository.deleteE2eeCredential(tx, owner, input.budgetId, input.expectedEpoch));
      return c.json({ configured: false, budgetId: input.budgetId, epoch });
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

  routes.post("/ai/byok/chat", async (c) => {
    const input = byokChatInput.parse(await c.req.json());
    const request: ChatRequest = { messages: input.messages, responseFormat: input.responseFormat, reasoningEffort: input.reasoningEffort };
    try {
      const content = await withClaimedPlainBudget(c, input.budgetId, (tx, owner) =>
        repository.withServerCredential(tx, owner, input.budgetId, (credential) => byokChatContent({ apiKey: credential, model: input.model, request })),
      );
      return c.json({ content });
    } catch (error) {
      return byokFailure(c, error);
    }
  });

  routes.post("/ai/byok/import/extract", async (c) => {
    const input = byokImportInput.parse(await c.req.json());
    try {
      const items = await withClaimedPlainBudget(c, input.budgetId, (tx, owner) =>
        repository.withServerCredential(tx, owner, input.budgetId, (credential) =>
          extractImportForBudget({
            budgetId: input.budgetId,
            accountId: input.accountId,
            images: input.images,
            locale: input.locale ?? "en",
            chat: (request, timeoutMs) => byokChatContent({ apiKey: credential, model: input.model, request, timeoutMs }),
          }),
        ),
      );
      return c.json(items);
    } catch (error) {
      return byokFailure(c, error instanceof ImportCycleOneFailure ? error.reason : error);
    }
  });

  return routes;
}
