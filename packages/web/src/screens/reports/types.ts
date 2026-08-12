import { type Message, msg } from "../../lib/i18n";

export type ReportTab = "assets" | "cashflow" | "spending" | "budgets" | "goals" | "month" | "trends";
/** Reports view: hub (band hero + mini-card grid) or a full-screen report subscreen. */
export type ReportView = "overview" | ReportTab;
export const TITLES: Record<ReportTab, Message> = {
  assets: msg("Wealth"),
  cashflow: msg("Cash flow"),
  spending: msg("Spending"),
  budgets: msg("Budgets"),
  goals: msg("Goals"),
  month: msg("Month in a nutshell"),
  trends: msg("Envelope trends"),
};
export type Mask = (n: number) => string;
