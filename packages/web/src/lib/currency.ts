import { isSupportedCurrency, type SupportedCurrency } from "@enveo/shared";

export { CURRENCY_DIGITS, SUPPORTED_CURRENCIES, type SupportedCurrency } from "@enveo/shared";

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

 
export const FALLBACK_CURRENCY: SupportedCurrency = "USD";








export const UNSET_BUDGET_CURRENCIES: readonly string[] = ["EUR", "PLN"];

/**
 * Region (ISO 3166-1) → currency, restricted to the list above — we never preselect a currency
 * the settings list cannot offer. Regions whose own currency the app does not carry map to the
 * closest supported unit (European ones → EUR); everything unmapped falls back to USD.
 */
const REGION_CURRENCY: Record<string, SupportedCurrency> = {
   
  AD: "EUR",
  AT: "EUR",
  BE: "EUR",
  CY: "EUR",
  DE: "EUR",
  EE: "EUR",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GR: "EUR",
  HR: "EUR",
  IE: "EUR",
  IT: "EUR",
  LT: "EUR",
  LU: "EUR",
  LV: "EUR",
  MC: "EUR",
  ME: "EUR",
  MT: "EUR",
  NL: "EUR",
  PT: "EUR",
  SI: "EUR",
  SK: "EUR",
  SM: "EUR",
  VA: "EUR",
  XK: "EUR",
  // European regions with a currency the app does not carry — the euro is the closest offer
  // (a PRESELECT, not a conversion: one tap changes it). IS is here because ISK is 0-decimal,
  // HU because the forint has no minor unit either (HUF: 0 digits — see CURRENCY_DIGITS).
  AL: "EUR",
  BA: "EUR",
  HU: "EUR",
  IS: "EUR",
  MD: "EUR",
  MK: "EUR",
   
  PL: "PLN",
  CZ: "CZK",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  UA: "UAH",
  RO: "RON",
  BG: "BGN",
  RS: "RSD",
  TR: "TRY",
  CH: "CHF",
  LI: "CHF",
  GB: "GBP",
  GG: "GBP",
  IM: "GBP",
  JE: "GBP",
   
  US: "USD",
  CA: "CAD",
  BR: "BRL",
  MX: "MXN",
  AR: "ARS",
  PE: "PEN",
   
  AU: "AUD",
  NZ: "NZD",
  IN: "INR",
  SG: "SGD",
  HK: "HKD",
  MY: "MYR",
  TH: "THB",
  PH: "PHP",
   
  IL: "ILS",
  PS: "ILS",
  AE: "AED",
  SA: "SAR",
  ZA: "ZAR",
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

/**
 * The currency the onboarding wizard preselects: the browser locale's, UNLESS the budget already
 * carries a deliberately chosen, supported currency (i.e. not an untouched server default) — that
 * one is kept, so re-entering the wizard never silently rewrites the user's own pick.
 */
export function wizardCurrency(budgetCurrency: string | null | undefined, locales: readonly string[]): string {
  if (budgetCurrency && isSupportedCurrency(budgetCurrency) && !UNSET_BUDGET_CURRENCIES.includes(budgetCurrency)) return budgetCurrency;
  return currencyForLocales(locales);
}
