/**
 * Currency: the list the app offers, and browser-locale → currency detection for the
 * onboarding preselect. PURE — no React, no I/O: the locale tags are passed in, so the
 * mapping is testable on its own (browserLocales() is the only navigator touch).
 *
 * MINOR-UNIT INVARIANT: amounts are integers of 1/100 of the major unit everywhere in the
 * domain (the ledger, the amount pad, formatMoney, the AI prompts). Only 2-decimal currencies
 * may be added below: a 0-decimal one (JPY, KRW, ISK, CLP, VND, HUF, COP, IDR) or a 3-decimal
 * one (KWD, BHD) would render and parse every stored amount 100× / 10× off. CURRENCY_DIGITS +
 * currency.test.ts assert the whole list, so adding one fails loudly. Supporting them means
 * threading a per-currency exponent through the pad, formatting, prompts and the property
 * tests — a separate project, deliberately out of scope.
 *
 * No conversion ever happens: the currency is a DISPLAY unit (formatMoney/currencySymbol).
 */

/**
 * CLDR minor-unit digits — PINNED, not read from the runtime's `Intl`.
 *
 * PITFALL (learned the hard way): `Intl` looks like the natural oracle for "is this currency
 * 2-decimal?", but a runtime's ICU can lag CLDR by years, and the answer CHANGES between ICU
 * versions. Bun 1.3 ships ICU 75, which still reports 2 fraction digits for HUF/COP/IDR; ICU 78
 * (Node 24 and every current browser) reports 0 — those three are 0-decimal today. A test that
 * asks the test runner's `Intl` would therefore have green-lit currencies that real browsers
 * render 100× off, and would silently flip red or green on the next toolchain bump.
 *
 * So: the digit count lives HERE, taken from current CLDR, and the tests check the list against
 * this table. Adding a currency means adding its digits here first — and only 2s may be offered.
 * Codes we deliberately do NOT support are listed too, so the exclusion carries its reason.
 */
export const CURRENCY_DIGITS: Readonly<Record<string, number>> = {
  AED: 2, ARS: 2, AUD: 2, BGN: 2, BRL: 2, CAD: 2, CHF: 2, CZK: 2, DKK: 2, EUR: 2, GBP: 2,
  HKD: 2, ILS: 2, INR: 2, MXN: 2, MYR: 2, NOK: 2, NZD: 2, PEN: 2, PHP: 2, PLN: 2, RON: 2,
  RSD: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TRY: 2, UAH: 2, USD: 2, ZAR: 2,
  // NOT supported — the ledger cannot represent them (see the invariant above)
  CLP: 0, COP: 0, HUF: 0, IDR: 0, ISK: 0, JPY: 0, KRW: 0, VND: 0,  
  BHD: 3, KWD: 3,  
};

/**
 * Currencies offered in onboarding and Settings → Appearance (ISO 4217, all 2-decimal per CURRENCY_DIGITS).
 * ALPHABETICAL — the pickers render this order in a flat <select>, and a code list of this size
 * is only scannable sorted. Membership, not order, is what the tests and the region map depend on.
 */
export const SUPPORTED_CURRENCIES = [
  "AED", "ARS", "AUD", "BGN", "BRL", "CAD", "CHF", "CZK", "DKK", "EUR", "GBP", "HKD", "ILS",
  "INR", "MXN", "MYR", "NOK", "NZD", "PEN", "PHP", "PLN", "RON", "RSD", "SAR", "SEK", "SGD",
  "THB", "TRY", "UAH", "USD", "ZAR",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

 
export const FALLBACK_CURRENCY: SupportedCurrency = "USD";








export const UNSET_BUDGET_CURRENCIES: readonly string[] = ["EUR", "PLN"];

/**
 * Region (ISO 3166-1) → currency, restricted to the list above — we never preselect a currency
 * the settings list cannot offer. Regions whose own currency the app does not carry map to the
 * closest supported unit (European ones → EUR); everything unmapped falls back to USD.
 */
const REGION_CURRENCY: Record<string, SupportedCurrency> = {
   
  AD: "EUR", AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR",
  FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR", LV: "EUR",
  MC: "EUR", ME: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR", SM: "EUR",
  VA: "EUR", XK: "EUR",
  // European regions with a currency the app does not carry — the euro is the closest offer
  // (a PRESELECT, not a conversion: one tap changes it). IS is here because ISK is 0-decimal,
  // HU because the forint has no minor unit either (HUF: 0 digits — see CURRENCY_DIGITS).
  AL: "EUR", BA: "EUR", HU: "EUR", IS: "EUR", MD: "EUR", MK: "EUR",
   
  PL: "PLN", CZ: "CZK", SE: "SEK", NO: "NOK", DK: "DKK", UA: "UAH",
  RO: "RON", BG: "BGN", RS: "RSD", TR: "TRY",
  CH: "CHF", LI: "CHF",
  GB: "GBP", GG: "GBP", IM: "GBP", JE: "GBP",
   
  US: "USD", CA: "CAD", BR: "BRL", MX: "MXN", AR: "ARS", PE: "PEN",
   
  AU: "AUD", NZ: "NZD", IN: "INR", SG: "SGD", HK: "HKD", MY: "MYR", TH: "THB", PH: "PHP",
   
  IL: "ILS", PS: "ILS", AE: "AED", SA: "SAR", ZA: "ZAR",
};





function regionOf(tag: string): string | null {
  const clean = tag.trim();
  if (!clean) return null;
  try {
    const region = new Intl.Locale(clean).maximize().region;
    if (region) return region.toUpperCase();
  } catch {
     
  }
  const m = /^[a-z]{2,3}[-_]([a-z]{2})(?:[-_]|$)/i.exec(clean);
  return m ? m[1]!.toUpperCase() : null;
}

 
export function currencyForLocale(tag: string | null | undefined): SupportedCurrency {
  const region = tag ? regionOf(tag) : null;
  return (region && REGION_CURRENCY[region]) || FALLBACK_CURRENCY;
}





export function currencyForLocales(tags: readonly string[]): SupportedCurrency {
  for (const tag of tags) {
    const region = regionOf(tag);
    const currency = region ? REGION_CURRENCY[region] : undefined;
    if (currency) return currency;
  }
  return FALLBACK_CURRENCY;
}

 
export function browserLocales(): string[] {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages;
  if (list && list.length > 0) return [...list];
  return navigator.language ? [navigator.language] : [];
}

const isSupported = (c: string): c is SupportedCurrency => (SUPPORTED_CURRENCIES as readonly string[]).includes(c);

/**
 * The currency the onboarding wizard preselects: the browser locale's, UNLESS the budget already
 * carries a deliberately chosen, supported currency (i.e. not an untouched server default) — that
 * one is kept, so re-entering the wizard never silently rewrites the user's own pick.
 */
export function wizardCurrency(budgetCurrency: string | null | undefined, locales: readonly string[]): string {
  if (budgetCurrency && isSupported(budgetCurrency) && !UNSET_BUDGET_CURRENCIES.includes(budgetCurrency)) return budgetCurrency;
  return currencyForLocales(locales);
}
