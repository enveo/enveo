import type { Lang } from "./i18n";

export const LOCALE_OF: Record<Lang, string> = { pl: "pl-PL", en: "en-US" };

 
export function formatMoney(minor: number, currency: string, lang: Lang, opts?: { trim?: boolean }): string {
  const whole = opts?.trim && minor % 100 === 0;
  return new Intl.NumberFormat(LOCALE_OF[lang], { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(minor / 100);
}

 
export function currencySymbol(currency: string, lang: Lang): string {
  const parts = new Intl.NumberFormat(LOCALE_OF[lang], { style: "currency", currency }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}

 
export function fmt(minor: number): string {
  const z = Math.abs(minor) / 100;
  const a = z.toFixed(2).replace(".", ",");
  const [i, d] = a.split(",");
  return i!.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + d;
}

 
export function fmtSigned(minor: number): string {
  return (minor < 0 ? "-" : "") + fmt(minor);
}

 
export function fmtTrim(minor: number): string {
  return fmt(minor).replace(/,00$/, "");
}

 
export function isLight(hex: string): boolean {
  const c = hex.replace("#", "");
  const r = parseInt(c.substr(0, 2), 16);
  const g = parseInt(c.substr(2, 2), 16);
  const b = parseInt(c.substr(4, 2), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

 
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (!cleaned) return null;
  const v = Number.parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

 
export function evalExpression(raw: string): number | null {
  if (!raw) return null;
  const norm = raw
    .replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, ".").replace(/\s/g, "")
    

    .replace(/(^|[+\-*/])0+(?=\d)/g, "$1");
  if (!/^[0-9+\-*/.]+$/.test(norm)) return parseAmount(raw);
  // A custom evaluator instead of Function()/eval — CSP script-src 'self' (without
  // 'unsafe-eval') blocks eval, and we eliminate the audit sink anyway. Grammar:
  // decimal numbers + operators + - * / without parentheses, standard precedence.
  const v = evalArith(norm);
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

 
function evalArith(s: string): number | null {
  const tok: Array<number | "+" | "-" | "*" | "/"> = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "+" || c === "-" || c === "*" || c === "/") {
       
      const prev = tok[tok.length - 1];
      if ((c === "-" || c === "+") && (tok.length === 0 || prev === "+" || prev === "-" || prev === "*" || prev === "/")) {
        let j = i + 1;
        while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
        const n = Number(s.slice(i, j));  
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
