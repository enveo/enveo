export function parseDisplayAmount(token: string): number | null {
  const compact = token.replace(/[\s ]/g, "");
  const decimal = /[.,](\d{2})$/.exec(compact);
  const integerPart = (decimal ? compact.slice(0, -3) : compact).replace(/[.,]/g, "");
  if (!/^-?\d+$/.test(integerPart)) return null;
  const minor = Number.parseInt(integerPart, 10) * 100 + (decimal ? Number.parseInt(decimal[1]!, 10) * (integerPart.startsWith("-") ? -1 : 1) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Symbols that name exactly one supported currency. `$`, `kr` or `R` are shared by several
 * currencies and never identify one on their own; the ISO code always does.
 */
const CURRENCY_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  CZK: ["Kč"],
  EUR: ["€"],
  GBP: ["£"],
  ILS: ["₪"],
  INR: ["₹"],
  PHP: ["₱"],
  PLN: ["zł"],
  THB: ["฿"],
  TRY: ["₺"],
  UAH: ["₴"],
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A money figure: grouped or plain integer part, at most two decimals. A rate such as
// 0.123456 has more and is never a figure.
const FIGURE = String.raw`\d{1,3}(?:[\s .,]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?`;

/**
 * The one amount printed in `currency` in these lines, or null when there is none or more than
 * one distinct figure (see `printedAmountsIn`). Exchange-rate expressions (`1.00 PLN = 0.2263 EUR`, a line ending in `=`
 * and the line it continues on) are not amounts.
 */
export function printedAmountIn(lines: readonly string[], currency: string): number | null {
  const figures = printedAmountsIn(lines, currency);
  return figures.length === 1 ? figures[0]! : null;
}

/** Every distinct amount printed in `currency`, rate expressions excluded. */
export function printedAmountsIn(lines: readonly string[], currency: string): number[] {
  const marks = [currency, ...(CURRENCY_SYMBOLS[currency] ?? [])].map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?<![\\d.,])(?:(${FIGURE})\\s*(?:${marks})(?![\\p{L}])|(?<![\\p{L}])(?:${marks})\\s*(${FIGURE})(?![\\d]|[.,]\\d))`, "giu");
  const figures = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (line.includes("=") || lines[index - 1]?.trimEnd().endsWith("=")) continue;
    for (const match of line.matchAll(pattern)) {
      const parsed = parseDisplayAmount(match[1] ?? match[2]!);
      if (parsed !== null && parsed !== 0) figures.add(Math.abs(parsed));
    }
  }
  return [...figures];
}
