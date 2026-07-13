/**
 * Currency: the list the app offers, and browser-locale → currency detection for the
 * onboarding preselect. PURE — no React, no I/O: the locale tags are passed in, so the
 * mapping is testable on its own (browserLocales() is the only navigator touch).
 *
 * MINOR-UNIT INVARIANT: amounts are integers of 1/100 of the major unit everywhere in the
 * domain. Only 2-decimal currencies may be added below — a 0-decimal one (JPY, HUF as used
 * in practice, KRW) would render every stored amount 100× off. currency.test.ts asserts this
 * against Intl for the whole list.
 *
 * No conversion ever happens: the currency is a DISPLAY unit (formatMoney/currencySymbol).
 */

 
export const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "NOK", "DKK", "CAD", "AUD", "UAH"] as const;

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
  // (a PRESELECT, not a conversion: one tap changes it)
  AL: "EUR", BA: "EUR", BG: "EUR", HU: "EUR", IS: "EUR", MD: "EUR", MK: "EUR", RO: "EUR", RS: "EUR",
   
  PL: "PLN", CZ: "CZK", SE: "SEK", NO: "NOK", DK: "DKK", UA: "UAH",
  CH: "CHF", LI: "CHF",
  GB: "GBP", GG: "GBP", IM: "GBP", JE: "GBP",
  US: "USD", CA: "CAD", AU: "AUD",
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
