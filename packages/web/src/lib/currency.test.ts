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
  test("a European region whose currency the app carries", () => {
    expect(currencyForLocale("pl-PL")).toBe("PLN");
    expect(currencyForLocale("en-GB")).toBe("GBP");
    expect(currencyForLocale("de-CH")).toBe("CHF");
    expect(currencyForLocale("cs-CZ")).toBe("CZK");
    expect(currencyForLocale("sv-SE")).toBe("SEK");
    expect(currencyForLocale("nb-NO")).toBe("NOK");
    expect(currencyForLocale("da-DK")).toBe("DKK");
    expect(currencyForLocale("uk-UA")).toBe("UAH");
    expect(currencyForLocale("hu-HU")).toBe("HUF");
    expect(currencyForLocale("ro-RO")).toBe("RON");
    expect(currencyForLocale("bg-BG")).toBe("BGN");
    expect(currencyForLocale("sr-RS")).toBe("RSD");
    expect(currencyForLocale("tr-TR")).toBe("TRY");
  });

  test("a region outside Europe whose currency the app carries", () => {
    expect(currencyForLocale("en-US")).toBe("USD");
    expect(currencyForLocale("fr-CA")).toBe("CAD");
    expect(currencyForLocale("en-AU")).toBe("AUD");
    expect(currencyForLocale("en-NZ")).toBe("NZD");
    expect(currencyForLocale("he-IL")).toBe("ILS");
    expect(currencyForLocale("ar-AE")).toBe("AED");
    expect(currencyForLocale("ar-SA")).toBe("SAR");
    expect(currencyForLocale("hi-IN")).toBe("INR");
    expect(currencyForLocale("en-SG")).toBe("SGD");
    expect(currencyForLocale("zh-HK")).toBe("HKD");
    expect(currencyForLocale("ms-MY")).toBe("MYR");
    expect(currencyForLocale("th-TH")).toBe("THB");
    expect(currencyForLocale("fil-PH")).toBe("PHP");
    expect(currencyForLocale("id-ID")).toBe("IDR");
    expect(currencyForLocale("en-ZA")).toBe("ZAR");
    expect(currencyForLocale("pt-BR")).toBe("BRL");
    expect(currencyForLocale("es-MX")).toBe("MXN");
    expect(currencyForLocale("es-AR")).toBe("ARS");
    expect(currencyForLocale("es-CO")).toBe("COP");
    expect(currencyForLocale("es-PE")).toBe("PEN");
  });

  test("the euro area", () => {
    for (const tag of ["de-DE", "fr-FR", "it-IT", "es-ES", "nl-NL", "pt-PT", "fi-FI", "el-GR", "sk-SK", "hr-HR"]) {
      expect(currencyForLocale(tag)).toBe("EUR");
    }
  });

  test("a European region with an unsupported currency → EUR (the closest offer, never an invented code)", () => {
    expect(currencyForLocale("is-IS")).toBe("EUR"); // ISK: 0-decimal, deliberately unsupported
    expect(currencyForLocale("sq-AL")).toBe("EUR"); // ALL is not on the list
    expect(currencyForLocale("bs-BA")).toBe("EUR");
    expect(currencyForLocale("mk-MK")).toBe("EUR");
    expect(currencyForLocale("ro-MD")).toBe("EUR");
  });

  test("language-only tags resolve through Intl likely-subtags", () => {
    expect(currencyForLocale("pl")).toBe("PLN");
    expect(currencyForLocale("de")).toBe("EUR");
    expect(currencyForLocale("cs")).toBe("CZK");
    expect(currencyForLocale("en")).toBe("USD");
    expect(currencyForLocale("hu")).toBe("HUF");
    expect(currencyForLocale("tr")).toBe("TRY");
    expect(currencyForLocale("th")).toBe("THB");
  });

  test("underscore tags and casing", () => {
    expect(currencyForLocale("pl_PL")).toBe("PLN");
    expect(currencyForLocale("EN-gb")).toBe("GBP");
  });

  test("unknown region, malformed and empty input → the fallback", () => {
    expect(currencyForLocale("ja-JP")).toBe(FALLBACK_CURRENCY); // JPY: 0-decimal, deliberately unsupported
    expect(currencyForLocale("ko-KR")).toBe(FALLBACK_CURRENCY); // KRW: 0-decimal
    expect(currencyForLocale("vi-VN")).toBe(FALLBACK_CURRENCY); // VND: 0-decimal
    expect(currencyForLocale("ar-KW")).toBe(FALLBACK_CURRENCY); // KWD: 3-decimal
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
    expect(wizardCurrency("JPY", ["de-DE"])).toBe("EUR"); // 0-decimal → never on the list
  });
});

describe("the supported list stays compatible with the money path", () => {
  test("every mapped/preselected currency is offered by the settings list", () => {
    const tags = ["pl-PL", "en-US", "en-GB", "de-DE", "de-CH", "cs-CZ", "sv-SE", "nb-NO", "da-DK", "uk-UA", "fr-CA", "en-AU", "en-NZ",
      "hu-HU", "ro-RO", "bg-BG", "sr-RS", "tr-TR", "he-IL", "hi-IN", "en-SG", "zh-HK", "ms-MY", "th-TH", "fil-PH", "id-ID", "en-ZA",
      "pt-BR", "es-MX", "es-AR", "es-CO", "es-PE", "ar-AE", "ar-SA", "is-IS", "ja-JP", ""];
    for (const tag of tags) expect(SUPPORTED_CURRENCIES).toContain(currencyForLocale(tag));
    expect(SUPPORTED_CURRENCIES).toContain(FALLBACK_CURRENCY);
  });

  test("the server defaults are on the list (the wizard select must be able to show them)", () => {
    for (const c of UNSET_BUDGET_CURRENCIES) expect(SUPPORTED_CURRENCIES).toContain(c as never);
  });

  test("no code appears twice", () => {
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
  });

  test("every supported currency has 2 decimals — the domain stores minor units of 1/100", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      const opts = new Intl.NumberFormat("en-US", { style: "currency", currency: c }).resolvedOptions();
      expect(opts.maximumFractionDigits).toBe(2);
      expect(opts.minimumFractionDigits).toBe(2);
    }
  });

  test("the non-2-decimal world stays OUT (0-decimal and 3-decimal codes would render 100× off)", () => {
    for (const c of ["JPY", "KRW", "ISK", "CLP", "VND", "KWD", "BHD"]) {
      expect(SUPPORTED_CURRENCIES).not.toContain(c as never);
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
