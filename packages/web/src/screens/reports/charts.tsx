import type { EnvelopeTrend } from "@enveo/shared";
import type { Theme } from "../../lib/theme";








export function trendColor(tr: EnvelopeTrend, C: Theme): string {
  if (tr.deltaPct === null || tr.last === tr.baseline) return C.mute;
  return tr.last > tr.baseline ? C.neg : C.pos;
}
