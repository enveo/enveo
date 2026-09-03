import { aiLocaleSchema, type BudgetPreferences, importJobDetailSchema, importJobSummarySchema, reconcileBudgetPreferences } from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type BudgetMeta, requireTier, sessionUserId } from "../context";
import { type DB, db } from "../db/client";
import * as schema from "../db/schema";
import { env } from "../env";
import { decodeImportJobImages, ImportJobImageError } from "../importJobs/images";
import { createImportJobRepository, ImportJobConflict, type ImportJobImageInput, type ImportJobRepository } from "../importJobs/repository";
import { budgetAssertionFails } from "./sync";

type Variables = { userId?: string };
type RouteContext = Context<{ Variables: Variables }>;

export type ImportJobRouteRepository = Pick<
  ImportJobRepository,
  "create" | "listForUser" | "getForUser" | "getForBudget" | "deleteMany" | "requestCancel" | "retry" | "markCompleted"
>;

export interface ImportJobRouteOptions {
  database?: DB;
  repository?: ImportJobRouteRepository;
  operatorModel?: string;
  wake?: () => void;
  resolvePlainBudget?: (context: RouteContext) => Promise<BudgetMeta>;
  readPreferences?: (budgetId: string) => Promise<BudgetPreferences>;
  accountBelongsToBudget?: (accountId: string, budgetId: string) => Promise<boolean>;
}

export const createImportJobInput = z
  .object({
    id: z.string().uuid(),
    budgetId: z.string().uuid(),
    accountId: z.string().uuid(),
    locale: aiLocaleSchema,
    images: z.array(z.string()).min(1).max(6),
  })
  .strict();
export const importJobMutationInput = z.object({ budgetId: z.string().uuid() }).strict();
export const deleteImportJobsInput = importJobMutationInput.extend({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
export const completeImportJobInput = importJobMutationInput.extend({
  appliedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});

function userId(c: RouteContext): string | null {
  return sessionUserId(c) ?? null;
}

function idParam(c: RouteContext): string {
  return z.string().uuid().parse(c.req.param("id"));
}

class InvalidImportJobPublicResponse extends Error {
  constructor() {
    super("invalid_import_job_public_response");
    this.name = "InvalidImportJobPublicResponse";
  }
}

function publicDetail(value: unknown) {
  const parsed = importJobDetailSchema.safeParse(value);
  if (!parsed.success) throw new InvalidImportJobPublicResponse();
  return parsed.data;
}

function publicList(value: unknown) {
  const parsed = importJobSummarySchema.array().safeParse(value);
  if (!parsed.success) throw new InvalidImportJobPublicResponse();
  return parsed.data;
}

export function createImportJobRoutes(options: ImportJobRouteOptions = {}) {
  const database = options.database ?? db;
  const repository = options.repository ?? createImportJobRepository(database);
  const resolvePlainBudget = options.resolvePlainBudget ?? ((c: RouteContext) => requireTier(c, "plain", database));
  const readPreferences =
    options.readPreferences ??
    (async (budgetId: string) => {
      const [budget] = await database.select({ preferences: schema.budgets.preferences }).from(schema.budgets).where(eq(schema.budgets.id, budgetId));
      if (!budget) throw new Error("budget_vanished");
      return reconcileBudgetPreferences(budget.preferences);
    });
  const accountBelongsToBudget =
    options.accountBelongsToBudget ??
    (async (accountId: string, budgetId: string) => {
      const [account] = await database
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.budgetId, budgetId)));
      return Boolean(account);
    });
  const operatorModel = options.operatorModel ?? env.OPENAI_MODEL;
  const wake = options.wake ?? (() => {});
  const routes = new Hono<{ Variables: Variables }>();

  async function authorizeMutation(c: RouteContext, claimedBudgetId: string) {
    const owner = userId(c);
    if (!owner) return { response: c.json({ error: "unauthorized" }, 401) } as const;
    const meta = await resolvePlainBudget(c);
    if (budgetAssertionFails(claimedBudgetId, meta.id)) return { response: c.json({ error: "budget_mismatch" }, 409) } as const;
    return { owner, meta } as const;
  }

  routes.post("/import/jobs", async (c) => {
    const body = createImportJobInput.parse(await c.req.json());
    const authorization = await authorizeMutation(c, body.budgetId);
    if ("response" in authorization) return authorization.response;
    if (!(await accountBelongsToBudget(body.accountId, authorization.meta.id))) return c.json({ error: "account_unavailable" }, 400);

    const preferences = await readPreferences(authorization.meta.id);
    if (preferences.aiProvider === "rules") return c.json({ error: "ai_capability_unsupported" }, 409);
    const provider =
      preferences.aiProvider === "enveo"
        ? { provider: "enveo" as const, model: operatorModel }
        : { provider: "openai" as const, model: preferences.openaiModel };

    let images: ImportJobImageInput[];
    try {
      images = decodeImportJobImages(body.images);
    } catch (error) {
      if (error instanceof ImportJobImageError) return c.json({ error: error.code }, error.code === "too_large" ? 413 : 400);
      throw error;
    }

    try {
      const result = await repository.create({
        id: body.id,
        userId: authorization.owner,
        budgetId: authorization.meta.id,
        accountId: body.accountId,
        provider,
        locale: body.locale,
        tier: "plain",
        epoch: authorization.meta.epoch,
        images,
      });
      const publicJob = publicDetail(result.job);
      if (result.created) wake();
      return c.json(publicJob, 202);
    } catch (error) {
      if (error instanceof ImportJobConflict) return c.json({ error: error.code }, 409);
      throw error;
    }
  });

  routes.get("/import/jobs", async (c) => {
    const owner = userId(c);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    return c.json(publicList(await repository.listForUser(owner)));
  });

  routes.get("/import/jobs/:id", async (c) => {
    const owner = userId(c);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const result = await repository.getForUser(owner, idParam(c));
    return result ? c.json(publicDetail(result)) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/import/jobs/delete", async (c) => {
    const body = deleteImportJobsInput.parse(await c.req.json());
    const authorization = await authorizeMutation(c, body.budgetId);
    if ("response" in authorization) return authorization.response;
    const deleted = await repository.deleteMany(authorization.owner, body.budgetId, [...new Set(body.ids)]);
    return c.json({ deleted });
  });

  routes.post("/import/jobs/:id/cancel", async (c) => {
    const body = importJobMutationInput.parse(await c.req.json());
    const authorization = await authorizeMutation(c, body.budgetId);
    if ("response" in authorization) return authorization.response;
    const result = await repository.requestCancel(authorization.owner, body.budgetId, idParam(c));
    return result ? c.json(publicDetail(result)) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/import/jobs/:id/retry", async (c) => {
    const body = importJobMutationInput.parse(await c.req.json());
    const authorization = await authorizeMutation(c, body.budgetId);
    if ("response" in authorization) return authorization.response;
    const result = await repository.retry(authorization.owner, body.budgetId, idParam(c));
    if (!result) return c.json({ error: "invalid_import_job_state" }, 409);
    const publicJob = publicDetail(result);
    wake();
    return c.json(publicJob);
  });

  routes.post("/import/jobs/:id/complete", async (c) => {
    const body = completeImportJobInput.parse(await c.req.json());
    const authorization = await authorizeMutation(c, body.budgetId);
    if ("response" in authorization) return authorization.response;
    const id = idParam(c);
    const current = await repository.getForBudget(authorization.owner, body.budgetId, id);
    if (!current) return c.json({ error: "not_found" }, 404);
    if (current.status !== "ready") return c.json({ error: "invalid_import_job_state" }, 409);
    const result = await repository.markCompleted(authorization.owner, body.budgetId, id, body.appliedCount, body.skippedCount);
    return result ? c.json(publicDetail(result)) : c.json({ error: "invalid_import_job_state" }, 409);
  });

  return routes;
}
