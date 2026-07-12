/**
 * Smart Quick-Add — rule-based natural-language parser into a transaction draft.
 * Pure (deterministic): the "today" date is passed as a parameter.
 *
 * Example (Polish input): "Biedronka 47,30 jedzenie wczoraj"
 *   → { amount: 4730, placeId: <Biedronka>, envelopeId: <Jedzenie>, date: <yesterday> }
 *
 * The result is a PROPOSAL — the frontend pre-fills the form with it, the user accepts.
 */

export interface QuickAddRefs {
  envelopes: Array<{ id: string; name: string }>;
  places: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
}

export interface QuickAddResult {
  amount: number | null; // minor units
  type: "expense" | "income";
  isRefund: boolean;
  date: string; // YYYY-MM-DD
  envelopeId: string | null;
  envelopeName: string | null;
  placeId: string | null;
  placeName: string | null;
  categoryId: string | null;
  note: string | null;
  confidence: number; // 0..1 how many fields were recognized
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function shiftDate(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** PL + EN weekday names (normalized, no diacritics), index = getUTCDay(). Product data — do not translate. */
const WEEKDAYS: string[][] = [
  ["niedziela", "niedziele", "sunday"],
  ["poniedzialek", "monday"],
  ["wtorek", "tuesday"],
  ["sroda", "srode", "wednesday"],
  ["czwartek", "thursday"],
  ["piatek", "friday"],
  ["sobota", "sobote", "saturday"],
];

/** Find a weekday in the text → index 0–6 or null. */
function matchWeekday(n: string): number | null {
  for (let i = 0; i < WEEKDAYS.length; i++) {
    for (const w of WEEKDAYS[i]!) {
      if (new RegExp(`\\b${w}\\b`).test(n)) return i;
    }
  }
  return null;
}

/** Keywords hinting at a typical envelope when there is no exact name. Polish NL data — do not translate. */
const ENVELOPE_HINTS: Record<string, string[]> = {
  jedzenie: ["jedzenie", "spozywcze", "spozywka", "obiad", "lunch", "kolacja", "kawa", "restauracja", "lidl", "biedronka", "zabka"],
  mieszkanie: ["mieszkanie", "czynsz", "dom", "meble", "wyposazenie"],
  samochod: ["samochod", "auto", "paliwo", "tankowanie", "orlen", "bp", "myjnia"],
  rachunki: ["rachunki", "prad", "gaz", "woda", "smieci", "internet", "telefon"],
  subskrypcje: ["subskrypcje", "netflix", "spotify", "hbo", "youtube", "icloud"],
  zdrowie: ["zdrowie", "lekarz", "apteka", "leki", "dentysta"],
  psiaki: ["psiaki", "pies", "kot", "weterynarz", "karma"],
  prezenty: ["prezent", "prezenty", "urodziny"],
  osobiste: ["osobiste", "ubrania", "fryzjer", "kosmetyki"],
};

export function parseQuickAdd(text: string, refs: QuickAddRefs, today: string): QuickAddResult {
  const raw = text.trim();
  const n = norm(raw);
  let hits = 0;

  // ── amount ── (e.g. 47,30  47.30  47  1 234,56)
  let amount: number | null = null;
  const amtMatch = raw.match(/(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(?:zl|z\u0142|pln)?/i);
  if (amtMatch && amtMatch[1]) {
    const cleaned = amtMatch[1].replace(/[\s\u00a0]/g, "").replace(",", ".");
    const value = Number.parseFloat(cleaned);
    if (Number.isFinite(value)) {
      amount = Math.round(value * 100);
      hits++;
    }
  }

  // ── type / refund ──
  let type: "expense" | "income" = "expense";
  let isRefund = false;
  if (/\b(przychod|wplata|wyplata|pensja|wynagrodzenie|odsetki|przelew przychodzacy)\b/.test(n)) {
    type = "income";
    hits++;
  } else if (/\b(zwrot|zwrocone|reklamacja)\b/.test(n)) {
    isRefund = true;
    hits++;
  }

  // ── date ── (PL + EN keywords)
  let date = today;
  const weekday = matchWeekday(n);
  if (/\bprzedwczoraj\b/.test(n) || /\bday before yesterday\b/.test(n)) {
    date = shiftDate(today, -2);
    hits++;
  } else if (/\bwczoraj\b/.test(n) || /\byesterday\b/.test(n)) {
    date = shiftDate(today, -1);
    hits++;
  } else if (/\b(dzis|dzisiaj|today)\b/.test(n)) {
    date = today;
    hits++;
  } else if (/\b(jutro|tomorrow)\b/.test(n)) {
    date = shiftDate(today, 1);
    hits++;
  } else if (weekday !== null) {
    // last past occurrence of the weekday (today's weekday = today)
    date = shiftDate(today, -((weekdayOf(today) - weekday + 7) % 7));
    hits++;
  } else {
    const dm = raw.match(/\b(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\b/);
    if (dm) {
      const d = dm[1]!.padStart(2, "0");
      const mo = dm[2]!.padStart(2, "0");
      const y = dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : today.slice(0, 4);
      date = `${y}-${mo}-${d}`;
      hits++;
    }
  }

  // ── place ── (match by name)
  let placeId: string | null = null;
  let placeName: string | null = null;
  for (const p of refs.places) {
    if (n.includes(norm(p.name))) {
      placeId = p.id;
      placeName = p.name;
      hits++;
      break;
    }
  }

  // ── envelope ── (exact name first, then hints)
  let envelopeId: string | null = null;
  let envelopeName: string | null = null;
  for (const e of refs.envelopes) {
    if (n.includes(norm(e.name))) {
      envelopeId = e.id;
      envelopeName = e.name;
      hits++;
      break;
    }
  }
  if (!envelopeId) {
    outer: for (const [envKey, words] of Object.entries(ENVELOPE_HINTS)) {
      for (const w of words) {
        if (n.includes(w)) {
          const match = refs.envelopes.find((e) => norm(e.name).includes(envKey));
          if (match) {
            envelopeId = match.id;
            envelopeName = match.name;
            hits++;
            break outer;
          }
        }
      }
    }
  }

  // ── category ──
  let categoryId: string | null = null;
  for (const c of refs.categories) {
    if (n.includes(norm(c.name))) {
      categoryId = c.id;
      hits++;
      break;
    }
  }

  return {
    amount,
    type,
    isRefund,
    date,
    envelopeId,
    envelopeName,
    placeId,
    placeName,
    categoryId,
    note: null,
    confidence: Math.min(1, hits / 4),
  };
}
