import { describe, expect, test } from "bun:test";
import {
  FALLBACK_CURRENCY,
  SUPPORTED_CURRENCIES,
  UNSET_BUDGET_CURRENCIES,
  currencyForLocale,
  currencyForLocales,
  wizardCurrency,
} from "./currency";
import { currencySymbol, formatMoney } from "./format";

describe("currencyForLocale — region → currency", () => {
  test("a region whose currency the app carries", () => {
    expect(currencyForLocale("pl-PL")).toBe("PLN");
    expect(currencyForLocale("en-US")).toBe("USD");
    expect(currencyForLocale("en-GB")).toBe("GBP");
    expect(currencyForLocale("de-CH")).toBe("CHF");
    expect(currencyForLocale("cs-CZ")).toBe("CZK");
    expect(currencyForLocale("sv-SE")).toBe("SEK");
    expect(currencyForLocale("nb-NO")).toBe("NOK");
    expect(currencyForLocale("da-DK")).toBe("DKK");
    expect(currencyForLocale("uk-UA")).toBe("UAH");
    expect(currencyForLocale("fr-CA")).toBe("CAD");
    expect(currencyForLocale("en-AU")).toBe("AUD");
  });

  test("the euro area", () => {
    for (const tag of ["de-DE", "fr-FR", "it-IT", "es-ES", "nl-NL", "pt-PT", "fi-FI", "el-GR", "sk-SK", "hr-HR"]) {
      expect(currencyForLocale(tag)).toBe("EUR");
    }
  });

  test("a European region with an unsupported currency → EUR (the closest offer, never an invented code)", () => {
    expect(currencyForLocale("hu-HU")).toBe("EUR"); // HUF is not on the list
    expect(currencyForLocale("ro-RO")).toBe("EUR");
    expect(currencyForLocale("bg-BG")).toBe("EUR");
    expect(currencyForLocale("is-IS")).toBe("EUR");
  });

  test("language-only tags resolve through Intl likely-subtags", () => {
    expect(currencyForLocale("pl")).toBe("PLN");
    expect(currencyForLocale("de")).toBe("EUR");
    expect(currencyForLocale("cs")).toBe("CZK");
    expect(currencyForLocale("en")).toBe("USD");
  });

  test("underscore tags and casing", () => {
    expect(currencyForLocale("pl_PL")).toBe("PLN");
    expect(currencyForLocale("EN-gb")).toBe("GBP");
  });

  test("unknown region, malformed and empty input → the fallback", () => {
    expect(currencyForLocale("ja-JP")).toBe(FALLBACK_CURRENCY); // JPY: 0-decimal, deliberately unsupported
    expect(currencyForLocale("hi-IN")).toBe(FALLBACK_CURRENCY);
    expect(currencyForLocale("!!!")).toBe(FALLBACK_CURRENCY);
    expect(currencyForLocale("")).toBe(FALLBACK_CURRENCY);
    expect(currencyForLocale(null)).toBe(FALLBACK_CURRENCY);
    expect(currencyForLocale(undefined)).toBe(FALLBACK_CURRENCY);
  });
});

describe("currencyForLocales — navigator.languages", () => {
  test("the first tag with a KNOWN region wins", () => {
    expect(currencyForLocales(["pl", "en-US"])).toBe("PLN");
    expect(currencyForLocales(["en-US", "pl-PL"])).toBe("USD");
  });

  test("an unmapped leading tag defers to the next one", () => {
    expect(currencyForLocales(["ja-JP", "en-GB"])).toBe("GBP");
  });

  test("an empty list → the fallback", () => {
    expect(currencyForLocales([])).toBe(FALLBACK_CURRENCY);
  });
});

describe("wizardCurrency — the onboarding preselect", () => {
  test("an untouched server default is replaced by the locale's currency", () => {
    expect(wizardCurrency("EUR", ["en-US"])).toBe("USD"); // the 2.1 DB default
    expect(wizardCurrency("PLN", ["de-DE"])).toBe("EUR"); // the legacy pre-2.1 default
    expect(wizardCurrency(undefined, ["pl-PL"])).toBe("PLN"); // before the replica boots
  });

  test("a currency the user picked deliberately is KEPT", () => {
    expect(wizardCurrency("CZK", ["en-US"])).toBe("CZK");
    expect(wizardCurrency("GBP", ["pl-PL"])).toBe("GBP");
  });

  test("a Polish browser still lands on PLN (the default is not a Poland preference any more)", () => {
    expect(wizardCurrency("EUR", ["pl-PL", "en-US"])).toBe("PLN");
  });

  test("an unsupported currency on the budget falls back to the locale (the select could not show it)", () => {
    expect(wizardCurrency("HUF", ["de-DE"])).toBe("EUR");
  });
});

describe("the supported list stays compatible with the money path", () => {
  test("every mapped/preselected currency is offered by the settings list", () => {
    const tags = ["pl-PL", "en-US", "en-GB", "de-DE", "de-CH", "cs-CZ", "sv-SE", "nb-NO", "da-DK", "uk-UA", "fr-CA", "en-AU", "hu-HU", "ja-JP", ""];
    for (const tag of tags) expect(SUPPORTED_CURRENCIES).toContain(currencyForLocale(tag));
    expect(SUPPORTED_CURRENCIES).toContain(FALLBACK_CURRENCY);
  });

  test("the server defaults are on the list (the wizard select must be able to show them)", () => {
    for (const c of UNSET_BUDGET_CURRENCIES) expect(SUPPORTED_CURRENCIES).toContain(c as never);
  });

  test("every supported currency has 2 decimals — the domain stores minor units of 1/100", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      const opts = new Intl.NumberFormat("en-US", { style: "currency", currency: c }).resolvedOptions();
      expect(opts.maximumFractionDigits).toBe(2);
    }
  });

  test("formatMoney/currencySymbol handle the whole list in both languages", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      for (const lang of ["pl", "en"] as const) {
        const s = formatMoney(123456, c, lang);
        expect(s).toContain(lang === "pl" ? "234,56" : "234.56"); // 1234.56 major units
        expect(currencySymbol(c, lang).length).toBeGreaterThan(0);
      }
    }
  });
});
