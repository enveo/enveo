/** Reading printed money out of screenshot text — pure, locale-agnostic, shared by review and recognition. */

/** "4 812,37" / "1,234.50" / "1.234,56" / "12" → minor units; the LAST separator followed by
 *  exactly two digits is the decimal mark, every other separator is grouping. */
export function parseDisplayAmount(token: string): number | null {
  const compact = token.replace(/[\s ]/g, "");
  const decimal = /[.,](\d{2})$/.exec(compact);
  const integerPart = (decimal ? compact.slice(0, -3) : compact).replace(/[.,]/g, "");
  if (!/^-?\d+$/.test(integerPart)) return null;
  const minor = Number.parseInt(integerPart, 10) * 100 + (decimal ? Number.parseInt(decimal[1]!, 10) * (integerPart.startsWith("-") ? -1 : 1) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** "18.21 EUR < 79.26 PLN" → 7926 when `currency` is PLN: the figure printed next to that currency code. */
export function printedAmountIn(lines: readonly string[], currency: string): number | null {
  const pattern = new RegExp(`(-?\\d[\\d\\s\\u00a0.,]*\\d|\\d)\\s*${currency}(?![A-Z])`, "i");
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    const parsed = parseDisplayAmount(match[1]!);
    if (parsed !== null) return Math.abs(parsed);
  }
  return null;
}
