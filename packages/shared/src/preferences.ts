import { z } from "zod";

export const LANGS = ["en", "pl", "de", "es", "fr", "it", "nl", "pt-BR", "cs", "sv"] as const;
export type Lang = (typeof LANGS)[number];

export const THEME_MODES = ["light", "dark", "auto"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const ACCENT_THEMES = ["teal", "duet"] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];

export const OPENAI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.5-mini"] as const;
export type OpenAiModel = (typeof OPENAI_MODELS)[number];

export const WIDGET_IDS = [
  "quickActions",
  "accounts",
  "envelopes",
  "envelopesSavings",
  "reportCashflow",
  "reportNetWorth",
  "attention",
  "recent",
  "spending",
  "goals",
  "trends",
  "heatmap",
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** Widgets allowed on the wide Home board — everything except the two that duplicate wide chrome
 *  (quick actions live in the primary header's Add, the account list in the rail). The single
 *  source the web catalogue derives `placements` from. */
export const WIDE_WIDGET_IDS = [
  "envelopes",
  "envelopesSavings",
  "reportCashflow",
  "reportNetWorth",
  "attention",
  "recent",
  "spending",
  "goals",
  "trends",
  "heatmap",
] as const;
export type WideWidgetId = (typeof WIDE_WIDGET_IDS)[number];

export const QUICK_ACTION_IDS = ["expense", "transfer", "import", "suggest", "discreet", "darkMode", "reports"] as const;
export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];

export interface WidgetOpts {
  collapsed?: boolean;
  count?: number;
  picked?: string[];
  mode?: string;
  actions?: QuickActionId[];
}

export interface WidgetConfig {
  id: WidgetId;
  enabled: boolean;
  opts?: WidgetOpts;
}

export interface WideWidgetConfig {
  id: WideWidgetId;
  enabled: boolean;
  /** Tile span in board columns, 1..4 — the DESKTOP count; render clamps to the current mode's. */
  w: number;
  /** Tile span in 92px board rows, 1..8. */
  h: number;
  opts?: WidgetOpts;
}

export interface CustomAiProfile {
  id: string;
  name: string;
  prompt: string;
}

export interface AccountPreferences {
  schemaVersion: 1;
  lang: Lang;
  themeMode: ThemeMode;
  accentTheme: AccentTheme;
}

export type AccountPreferenceField = "lang" | "themeMode" | "accentTheme";
export type AccountPreferencesPatch = Partial<Pick<AccountPreferences, AccountPreferenceField>>;

export interface BudgetPreferences {
  schemaVersion: 2;
  aiProvider: "rules" | "enveo" | "openai";
  openaiModel: OpenAiModel;
  customProfiles: CustomAiProfile[];
  startWidgets: WidgetConfig[]; // phone stack — order is render order, unchanged semantics
  wideWidgets: WideWidgetConfig[]; // wide board, order is grid placement order
}

export type BudgetPreferenceField = "aiProvider" | "openaiModel" | "customProfiles" | "startWidgets" | "wideWidgets";
export type BudgetPreferencesPatch = Partial<Pick<BudgetPreferences, BudgetPreferenceField>>;

const langSchema = z.enum(LANGS);
const themeModeSchema = z.enum(THEME_MODES);
const accentThemeSchema = z.enum(ACCENT_THEMES);
const openAiModelSchema = z.enum(OPENAI_MODELS);
const uuidSchema = z.string().uuid();

export const accountPreferencesSchema = z
  .object({ schemaVersion: z.literal(1), lang: langSchema, themeMode: themeModeSchema, accentTheme: accentThemeSchema })
  .strict();

export const accountPreferencesPatchSchema = z
  .object({ lang: langSchema.optional(), themeMode: themeModeSchema.optional(), accentTheme: accentThemeSchema.optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "preference patch must not be empty" });

const customAiProfileSchema = z.object({ id: uuidSchema, name: z.string().trim().min(1), prompt: z.string().trim().min(1) }).strict();

const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

const quickActionsWidgetSchema = z
  .object({
    id: z.literal("quickActions"),
    enabled: z.boolean(),
    opts: z
      .object({ actions: z.array(z.enum(QUICK_ACTION_IDS)).refine(unique, { message: "quick actions must be unique" }) })
      .strict()
      .optional(),
  })
  .strict();

const accountsWidgetSchema = z
  .object({
    id: z.literal("accounts"),
    enabled: z.boolean(),
    opts: z
      .object({
        collapsed: z.boolean().optional(),
        count: z.number().int().min(2).max(8).optional(),
        picked: z.array(uuidSchema).refine(unique, { message: "account references must be unique" }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function validEnvelopeMode(mode: string): boolean {
  if (mode === "all" || mode === "savings" || mode === "picked:") return true;
  const [kind, rawIds, extra] = mode.split(":");
  if (extra !== undefined || (kind !== "group" && kind !== "picked") || rawIds === undefined || rawIds === "") return false;
  const ids = rawIds.split(",");
  return (kind === "group" ? ids.length === 1 : unique(ids)) && ids.every((id) => uuidSchema.safeParse(id).success);
}

const envelopesWidgetSchema = z
  .object({
    id: z.literal("envelopes"),
    enabled: z.boolean(),
    opts: z
      .object({ mode: z.string().refine(validEnvelopeMode, { message: "invalid envelope selection mode" }) })
      .strict()
      .optional(),
  })
  .strict();

type OptionlessWidgetId = "envelopesSavings" | "reportCashflow" | "reportNetWorth" | "attention" | "recent" | "spending" | "goals" | "trends" | "heatmap";
const optionlessWidget = <T extends OptionlessWidgetId>(id: T) => z.object({ id: z.literal(id), enabled: z.boolean() }).strict();

export const widgetConfigSchema = z.union([
  quickActionsWidgetSchema,
  accountsWidgetSchema,
  envelopesWidgetSchema,
  optionlessWidget("envelopesSavings"),
  optionlessWidget("reportCashflow"),
  optionlessWidget("reportNetWorth"),
  optionlessWidget("attention"),
  optionlessWidget("recent"),
  optionlessWidget("spending"),
  optionlessWidget("goals"),
  optionlessWidget("trends"),
  optionlessWidget("heatmap"),
]);

const widgetStackSchema = z.array(widgetConfigSchema).refine((widgets) => unique(widgets.map((widget) => widget.id)), { message: "widget ids must be unique" });

/* ── Wide board (schemaVersion 2) ─────────────────────────────────────── */

const wideFrame = { enabled: z.boolean(), w: z.number().int().min(1).max(4), h: z.number().int().min(1).max(8) };

const optionlessWide = <T extends WideWidgetId>(id: T) => z.object({ id: z.literal(id), ...wideFrame }).strict();

const envelopesWideWidgetSchema = z
  .object({
    id: z.literal("envelopes"),
    ...wideFrame,
    opts: z
      .object({ mode: z.string().refine(validEnvelopeMode, { message: "invalid envelope selection mode" }) })
      .strict()
      .optional(),
  })
  .strict();

export const wideWidgetConfigSchema = z.union([
  envelopesWideWidgetSchema,
  optionlessWide("envelopesSavings"),
  optionlessWide("reportCashflow"),
  optionlessWide("reportNetWorth"),
  optionlessWide("attention"),
  optionlessWide("recent"),
  optionlessWide("spending"),
  optionlessWide("goals"),
  optionlessWide("trends"),
  optionlessWide("heatmap"),
]);

const wideWidgetStackSchema = z
  .array(wideWidgetConfigSchema)
  .refine((widgets) => unique(widgets.map((widget) => widget.id)), { message: "widget ids must be unique" });

export const budgetPreferencesSchema = z
  .object({
    schemaVersion: z.literal(2),
    aiProvider: z.enum(["rules", "enveo", "openai"]),
    openaiModel: openAiModelSchema,
    customProfiles: z
      .array(customAiProfileSchema)
      .refine((profiles) => unique(profiles.map((profile) => profile.id)), { message: "profile ids must be unique" }),
    startWidgets: widgetStackSchema,
    wideWidgets: wideWidgetStackSchema,
  })
  .strict();

export const budgetPreferencesPatchSchema = z
  .object({
    aiProvider: z.enum(["rules", "enveo", "openai"]).optional(),
    openaiModel: openAiModelSchema.optional(),
    customProfiles: z
      .array(customAiProfileSchema)
      .refine((profiles) => unique(profiles.map((profile) => profile.id)), { message: "profile ids must be unique" })
      .optional(),
    startWidgets: widgetStackSchema.optional(),
    wideWidgets: wideWidgetStackSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "preference patch must not be empty" });

export function createDefaultStartWidgets(): WidgetConfig[] {
  return [
    { id: "quickActions", enabled: true, opts: { actions: ["expense", "transfer", "import", "suggest"] } },
    { id: "accounts", enabled: true, opts: { collapsed: true, count: 4 } },
    { id: "envelopes", enabled: true, opts: { mode: "all" } },
    { id: "envelopesSavings", enabled: false },
    { id: "reportCashflow", enabled: true },
    { id: "reportNetWorth", enabled: false },
    // New widgets ship disabled by default on phone: "available on mobile too" means offered
    // in Edit widgets, not imposed on every existing Start (product decision, PR5 reconciliation).
    { id: "attention", enabled: false },
    { id: "recent", enabled: false },
    { id: "spending", enabled: false },
    { id: "goals", enabled: false },
    { id: "trends", enabled: false },
    { id: "heatmap", enabled: false },
  ];
}

/** Default wide Home board — ported verbatim from the approved design mock's array (app widget ids). */
export function createDefaultWideWidgets(): WideWidgetConfig[] {
  return [
    // w:2/h:2, not the mock's 1x1: the body (amount + 12-mo sparkline) measures ~94x189px, and a
    // 1x1 tile shows 38px of it behind a scrollbar — a scrolling sparkline is not a widget.
    // Measured clean at 2x2 (382x196 content box) on the 1440px board.
    { id: "reportNetWorth", enabled: true, w: 2, h: 2 },
    { id: "reportCashflow", enabled: true, w: 3, h: 1 },
    { id: "envelopes", enabled: true, w: 2, h: 2, opts: { mode: "all" } },
    { id: "recent", enabled: true, w: 2, h: 4 },
    { id: "spending", enabled: true, w: 2, h: 2 },
    { id: "trends", enabled: true, w: 2, h: 2 },
    { id: "attention", enabled: true, w: 2, h: 2 },
    { id: "goals", enabled: true, w: 2, h: 2 },
    { id: "heatmap", enabled: true, w: 2, h: 2 },
    { id: "envelopesSavings", enabled: false, w: 2, h: 2 },
  ];
}

export function createDefaultAccountPreferences(lang: Lang = "en"): AccountPreferences {
  return { schemaVersion: 1, lang, themeMode: "light", accentTheme: "teal" };
}

export function createDefaultBudgetPreferences(): BudgetPreferences {
  return {
    schemaVersion: 2,
    aiProvider: "rules",
    openaiModel: "gpt-5.6-luna",
    customProfiles: [],
    startWidgets: createDefaultStartWidgets(),
    wideWidgets: createDefaultWideWidgets(),
  };
}

function reconcileWidgets(raw: unknown): WidgetConfig[] {
  const defaults = createDefaultStartWidgets();
  if (!Array.isArray(raw)) return defaults;

  const widgets: WidgetConfig[] = [];
  const seen = new Set<WidgetId>();
  for (const candidate of raw) {
    const parsed = widgetConfigSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    widgets.push(parsed.data);
  }
  for (const widget of defaults) {
    if (!seen.has(widget.id)) widgets.push(widget);
  }
  return widgets;
}

function reconcileWideWidgets(raw: unknown): WideWidgetConfig[] {
  const defaults = createDefaultWideWidgets();
  if (!Array.isArray(raw)) return defaults;

  const widgets: WideWidgetConfig[] = [];
  const seen = new Set<WideWidgetId>();
  for (const candidate of raw) {
    const parsed = wideWidgetConfigSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    widgets.push(parsed.data);
  }
  for (const widget of defaults) {
    if (!seen.has(widget.id)) widgets.push(widget);
  }
  return widgets;
}

/**
 * Field-wise compatibility boundary for backups, JSONB, IndexedDB, and future defaults — the ONE
 * function every consumer (server read, server op apply, client reducer, backup/replace import,
 * the web store) routes through. This function IS the entire v1→v2 migration: there is
 * deliberately no separate `migrateV1toV2`, because a second path would eventually disagree with
 * this one. A pre-v2 replica/row carries no `wideWidgets` key at all (not `null`, not `[]` — no
 * key); `Array.isArray(raw)` on `undefined` is false, so it falls straight to the default board.
 */
export function reconcileBudgetPreferences(raw: unknown): BudgetPreferences {
  const defaults = createDefaultBudgetPreferences();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const source = raw as Record<string, unknown>;
  const aiProvider = z.enum(["rules", "enveo", "openai"]).safeParse(source.aiProvider);
  const openaiModel = openAiModelSchema.safeParse(source.openaiModel);
  const customProfiles = z
    .array(customAiProfileSchema)
    .refine((profiles) => unique(profiles.map((profile) => profile.id)))
    .safeParse(source.customProfiles);
  return {
    schemaVersion: 2,
    aiProvider: aiProvider.success ? aiProvider.data : defaults.aiProvider,
    openaiModel: openaiModel.success ? openaiModel.data : defaults.openaiModel,
    customProfiles: customProfiles.success ? customProfiles.data : defaults.customProfiles,
    startWidgets: reconcileWidgets(source.startWidgets),
    wideWidgets: reconcileWideWidgets(source.wideWidgets),
  };
}
