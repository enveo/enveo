import type { EnvelopeTrend } from "@enveo/shared";
import type { Theme } from "../../lib/theme";

/** Stroke/verdict color for an envelope trend: `C.mute` when there is no baseline to compare
 *  against (`deltaPct` null — nothing spent in the months before the last one) or the series is
 *  flat (`last === baseline`), else `C.neg` on the way up / `C.pos` on the way down — spending
 *  semantics, rising is the "bad" direction. Shared by the hub's TrendsMini and the Trends
 *  subscreen (Task 12) so a row's TrendSpark stroke and its rising/falling arrow always agree —
 *  the original TrendsMini compared `last`/`baseline` alone and could paint C.neg/C.pos even with
 *  no baseline to compare against (baseline 0, deltaPct null); that case now reads as neutral. */
export function trendColor(tr: EnvelopeTrend, C: Theme): string {
  if (tr.deltaPct === null || tr.last === tr.baseline) return C.mute;
  return tr.last > tr.baseline ? C.neg : C.pos;
}
