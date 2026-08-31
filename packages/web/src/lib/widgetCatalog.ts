/**
 * The widget catalogue — ONE eager registry of metadata (title, where a widget may appear,
 * whether its edit surface shows an options body) for every `WidgetId`. Deliberately metadata
 * ONLY: it must never import a widget BODY (`./widgets`, wide widget bodies, report screens) —
 * a single stray body import here would drag that body into the eager closure (§3f), since this
 * module is imported by `EditWidgetsSheet` (lazy) but is itself small enough to be safe to keep
 * eager for whoever needs titles/placement before opening any sheet (e.g. a future wide board
 * "Add widget" ghost tile).
 *
 * `wide`/`configurable` are DERIVED, not hand-duplicated: `wide` comes straight from the shared
 * `WIDE_WIDGET_IDS` allowlist (the wide board's own schema already keys off it), so the two
 * lists cannot drift apart. `configurable` stays an explicit set — "has options today" is a
 * product fact, not something derivable from the shared schema.
 */
import { WIDE_WIDGET_IDS, type WideWidgetId, type WidgetId } from "@enveo/shared";
import { type Message, msg } from "./i18n";

export interface WidgetCatalogEntry {
  id: WidgetId;
  /** `t(entry.title)` at render — titles live HERE, once. */
  title: Message;
  /** One line saying what the widget SHOWS, for a surface that offers a widget the user has never
   *  seen: the wide board's add-widget picker (owner round 6 item 28). Present for exactly the
   *  `wide` ids — that picker is the only consumer, and `widgetCatalog.test.ts` pins the pairing so
   *  a future wide id cannot land in the picker as a bare title. Phone-only ids (quickActions,
   *  accounts) omit it: the phone's Edit-widgets sheet lists a fixed, already-familiar stack. */
  description?: Message;
  /** Every widget is offered on the phone stack (Edit widgets), even ones shipped disabled by default. */
  phone: true;
  /** Whether this widget may appear on the wide Home board. */
  wide: boolean;
  /** True when the edit surfaces (EditWidgetsSheet today) show an options body for this widget. */
  configurable: boolean;
}

const WIDE_SET: ReadonlySet<WidgetId> = new Set<WidgetId>(WIDE_WIDGET_IDS);

/** Widgets whose edit surface shows an options body — quickActions (action picker),
 *  accounts (collapsed/count/picked) and envelopes (selection mode). Kept explicit rather than
 *  "has a WidgetOpts shape", since a future options-less field must not silently grow this list. */
const CONFIGURABLE_IDS: ReadonlySet<WidgetId> = new Set<WidgetId>(["quickActions", "accounts", "envelopes"]);

function entry(id: WidgetId, title: Message, description?: Message): WidgetCatalogEntry {
  return { id, title, description, phone: true, wide: WIDE_SET.has(id), configurable: CONFIGURABLE_IDS.has(id) };
}

export const WIDGET_CATALOG: Record<WidgetId, WidgetCatalogEntry> = {
  quickActions: entry("quickActions", msg("Quick actions")),
  accounts: entry("accounts", msg("Accounts")),
  envelopes: entry("envelopes", msg("Envelopes"), msg("Every envelope with what is left this month.")),
  envelopesSavings: entry("envelopesSavings", msg("Envelopes · Savings"), msg("Only the envelopes you marked as savings.")),
  // Design's WIDGET_TITLE map drops the "Report · " prefix on the wide board (v3.dc.html:3583) —
  // the phone widgets' own SectionEyebrow keeps "Report · Cash flow"/"Report · Net worth" as a
  // separate, unrelated string (components/widgets.tsx), so this rename is catalog-only.
  reportCashflow: entry("reportCashflow", msg("Cash flow · 12 months"), msg("Money in and out over the last twelve months.")),
  reportNetWorth: entry("reportNetWorth", msg("Net worth"), msg("What you own minus what you owe, month by month.")),
  attention: entry("attention", msg("Needs attention"), msg("Overspent envelopes and everything else that needs a decision.")),
  recent: entry("recent", msg("Recent activity"), msg("The latest transactions across all accounts.")),
  // Design's WIDGET_TITLE map (v3.dc.html:3583) — a wide board card header, not the Reports hub's
  // own "Spending" tile title (screens/reports/types.ts TITLES), which stays a separate key.
  spending: entry("spending", msg("Spending · by envelope"), msg("Where this month's money went, envelope by envelope.")),
  goals: entry("goals", msg("Goals"), msg("A progress ring for every envelope with a goal.")),
  trends: entry("trends", msg("Envelope trends"), msg("A sparkline per envelope with its change this month.")),
  heatmap: entry("heatmap", msg("When you spend"), msg("Which days you spend on, and the places you visit most.")),
};

export function isWideWidget(id: WidgetId): id is WideWidgetId {
  return WIDE_SET.has(id);
}
