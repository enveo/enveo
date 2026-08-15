import {
  type AccountPreferences,
  type AccountPreferencesPatch,
  accountPreferencesPatchSchema,
  accountPreferencesSchema,
  createDefaultAccountPreferences,
} from "@enveo/shared";
import { sql as dsql, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { sessionUserId } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { Executor } from "../sync/apply";

export type AccountPreferencesResponse = AccountPreferences & { revision: number };

type StoredAccountPreferences = { lang: string; themeMode: string; accentTheme: string; revision: number };

export const accountPreferencesPatchInput = z.object({ userId: z.string().min(1), patch: accountPreferencesPatchSchema }).strict();

export function canonicalAccountPreferences(row: StoredAccountPreferences | undefined): AccountPreferencesResponse {
  const defaults = createDefaultAccountPreferences();
  if (!row) return { ...defaults, revision: 0 };
  const parsed = accountPreferencesSchema.safeParse({ schemaVersion: 1, lang: row.lang, themeMode: row.themeMode, accentTheme: row.accentTheme });
  const value = parsed.success ? parsed.data : defaults;
  return { ...value, revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0 };
}

export async function readAccountPreferences(x: Executor, userId: string): Promise<AccountPreferencesResponse> {
  const [row] = await x
    .select({
      lang: s.accountPreferences.lang,
      themeMode: s.accountPreferences.themeMode,
      accentTheme: s.accountPreferences.accentTheme,
      revision: s.accountPreferences.revision,
    })
    .from(s.accountPreferences)
    .where(eq(s.accountPreferences.userId, userId));
  return canonicalAccountPreferences(row);
}

export async function patchAccountPreferences(x: Executor, userId: string, patch: AccountPreferencesPatch): Promise<AccountPreferencesResponse> {
  const defaults = createDefaultAccountPreferences();
  const [row] = await x
    .insert(s.accountPreferences)
    .values({
      userId,
      lang: patch.lang ?? defaults.lang,
      themeMode: patch.themeMode ?? defaults.themeMode,
      accentTheme: patch.accentTheme ?? defaults.accentTheme,
      revision: 1,
    })
    .onConflictDoUpdate({
      target: s.accountPreferences.userId,
      set: {
        ...(patch.lang !== undefined ? { lang: patch.lang } : {}),
        ...(patch.themeMode !== undefined ? { themeMode: patch.themeMode } : {}),
        ...(patch.accentTheme !== undefined ? { accentTheme: patch.accentTheme } : {}),
        revision: dsql`${s.accountPreferences.revision} + 1`,
        updatedAt: dsql`now()`,
      },
    })
    .returning({
      lang: s.accountPreferences.lang,
      themeMode: s.accountPreferences.themeMode,
      accentTheme: s.accountPreferences.accentTheme,
      revision: s.accountPreferences.revision,
    });
  return canonicalAccountPreferences(row);
}

export const preferencesRoutes = new Hono();

preferencesRoutes.get("/preferences/account", async (c) => {
  const userId = sessionUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  return c.json(await readAccountPreferences(db, userId));
});

preferencesRoutes.patch("/preferences/account", async (c) => {
  const body = accountPreferencesPatchInput.parse(await c.req.json());
  const currentUserId = sessionUserId(c);
  if (!currentUserId) return c.json({ error: "unauthorized" }, 401);
  if (body.userId !== currentUserId) return c.json({ error: "budget_mismatch" }, 409);
  return c.json(await patchAccountPreferences(db, currentUserId, body.patch));
});
