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
   
  title: Message;
   
  phone: true;
   
  wide: boolean;
   
  configurable: boolean;
}

const WIDE_SET: ReadonlySet<WidgetId> = new Set<WidgetId>(WIDE_WIDGET_IDS);

/** Widgets whose edit surface shows an options body — quickActions (action picker),
 *  accounts (collapsed/count/picked) and envelopes (selection mode). Kept explicit rather than
 *  "has a WidgetOpts shape", since a future options-less field must not silently grow this list. */
const CONFIGURABLE_IDS: ReadonlySet<WidgetId> = new Set<WidgetId>(["quickActions", "accounts", "envelopes"]);

function entry(id: WidgetId, title: Message): WidgetCatalogEntry {
  return { id, title, phone: true, wide: WIDE_SET.has(id), configurable: CONFIGURABLE_IDS.has(id) };
}

export const WIDGET_CATALOG: Record<WidgetId, WidgetCatalogEntry> = {
  quickActions: entry("quickActions", msg("Quick actions")),
  accounts: entry("accounts", msg("Accounts")),
  envelopes: entry("envelopes", msg("Envelopes")),
  envelopesSavings: entry("envelopesSavings", msg("Envelopes · Savings")),
  reportCashflow: entry("reportCashflow", msg("Report · Cash flow")),
  reportNetWorth: entry("reportNetWorth", msg("Report · Net worth")),
  attention: entry("attention", msg("Needs attention")),
  recent: entry("recent", msg("Recent activity")),
   
  spending: entry("spending", msg("Spending")),
  goals: entry("goals", msg("Goals")),
  trends: entry("trends", msg("Envelope trends")),
  heatmap: entry("heatmap", msg("When you spend")),
};

export function isWideWidget(id: WidgetId): id is WideWidgetId {
  return WIDE_SET.has(id);
}
