import type { Lang } from "./i18n";

export const LOCALE_OF: Record<Lang, string> = { pl: "pl-PL", en: "en-US" };

/** Amount with a currency symbol per locale (minor units → e.g. "1 234,56 zł" / "$1,234.56"). */
export function formatMoney(minor: number, currency: string, lang: Lang, opts?: { trim?: boolean }): string {
  const whole = opts?.trim && minor % 100 === 0;
  return new Intl.NumberFormat(LOCALE_OF[lang], { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(minor / 100);
}

/** The currency symbol alone ("zł", "$", "€") — for labels next to inputs. */
export function currencySymbol(currency: string, lang: Lang): string {
  const parts = new Intl.NumberFormat(LOCALE_OF[lang], { style: "currency", currency }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}

/** Amount formatting. Input in MINOR UNITS (integer). Output e.g. "1 234,56". */
export function fmt(minor: number): string {
  const z = Math.abs(minor) / 100;
  const a = z.toFixed(2).replace(".", ",");
  const [i, d] = a.split(",");
  return i!.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + d;
}

/** Amount with a sign (for negatives). */
export function fmtSigned(minor: number): string {
  return (minor < 0 ? "-" : "") + fmt(minor);
}

/** Like fmt, but round amounts without ",00" (the original style: "+80 000 zł", "0 zł"). */
export function fmtTrim(minor: number): string {
  return fmt(minor).replace(/,00$/, "");
}

/** Whether a color is light (for picking dark/light text). */
export function isLight(hex: string): boolean {
  const c = hex.replace("#", "");
  const r = parseInt(c.substr(0, 2), 16);
  const g = parseInt(c.substr(2, 2), 16);
  const b = parseInt(c.substr(4, 2), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/** Parses a typed amount "1 234,56" / "12.5" → minor units. null when empty/invalid. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (!cleaned) return null;
  const v = Number.parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/** Evaluates a simple numpad expression (+ − × ÷), result in minor units. */
export function evalExpression(raw: string): number | null {
  if (!raw) return null;
  const norm = raw
    .replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, ".").replace(/\s/g, "")
    // leading zeros ("047.30", "07") are octal literals in strict mode → SyntaxError
    // → null → a split sum of "0,00" despite the typed amount; we strip them per numeric token
    .replace(/(^|[+\-*/])0+(?=\d)/g, "$1");
  if (!/^[0-9+\-*/.]+$/.test(norm)) return parseAmount(raw);
  // A custom evaluator instead of Function()/eval — CSP script-src 'self' (without
  // 'unsafe-eval') blocks eval, and we eliminate the audit sink anyway. Grammar:
  // decimal numbers + operators + - * / without parentheses, standard precedence.
  const v = evalArith(norm);
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/** Safe arithmetic evaluator (no eval): +−×÷ on numbers, ×÷ precedence over +−, left to right. */
function evalArith(s: string): number | null {
  const tok: Array<number | "+" | "-" | "*" | "/"> = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      // unary minus/plus at the start or after an operator → absorb into the number
      const prev = tok[tok.length - 1];
      if ((c === "-" || c === "+") && (tok.length === 0 || prev === "+" || prev === "-" || prev === "*" || prev === "/")) {
        let j = i + 1;
        while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
        const n = Number(s.slice(i, j)); // the slice includes the sign
        if (!Number.isFinite(n)) return null;
        tok.push(n);
        i = j;
        continue;
      }
      tok.push(c);
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      const n = Number(s.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tok.push(n);
      i = j;
    } else {
      return null; // unexpected character (should not get past the regex)
    }
  }
  if (tok.length === 0) return null;
  // phase 1: × ÷
  const acc: Array<number | "+" | "-"> = [];
  for (let k = 0; k < tok.length; k++) {
    const t = tok[k]!;
    if (t === "*" || t === "/") {
      const a = acc.pop();
      const b = tok[++k];
      if (typeof a !== "number" || typeof b !== "number") return null;
      acc.push(t === "*" ? a * b : b === 0 ? NaN : a / b);
    } else acc.push(t);
  }
  // phase 2: + −
  let cur = acc[0];
  if (typeof cur !== "number") return null;
  for (let k = 1; k < acc.length; k += 2) {
    const op = acc[k];
    const n = acc[k + 1];
    if (typeof n !== "number") return null;
    cur = op === "+" ? cur + n : op === "-" ? cur - n : NaN;
  }
  return cur;
}
