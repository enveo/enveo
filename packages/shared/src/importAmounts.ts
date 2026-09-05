 



export function parseDisplayAmount(token: string): number | null {
  const compact = token.replace(/[\s ]/g, "");
  const decimal = /[.,](\d{2})$/.exec(compact);
  const integerPart = (decimal ? compact.slice(0, -3) : compact).replace(/[.,]/g, "");
  if (!/^-?\d+$/.test(integerPart)) return null;
  const minor = Number.parseInt(integerPart, 10) * 100 + (decimal ? Number.parseInt(decimal[1]!, 10) * (integerPart.startsWith("-") ? -1 : 1) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Reads the figure printed next to the requested currency code; never computes an exchange rate. */
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
