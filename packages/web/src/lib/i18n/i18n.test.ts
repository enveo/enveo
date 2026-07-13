/**
 * The message IS the key, so the dictionary cannot drift silently — these tests are what makes the
 * pattern safe:
 *
 *  - messages.generated.ts must match the source (it types every t() call site);
 *  - a locale may not carry an ORPHAN — editing an English string changes its key, which silently
 *    invalidates that string's translations. The orphan list names exactly what to re-translate;
 *  - plural entries must carry the CLDR categories their language requires (computed, never
 *    hand-written);
 *  - and the words a user must TYPE to confirm a destructive action must stay typeable.
 */
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { describe, expect, it } from "bun:test";
import { extract } from "../../../scripts/i18n-extract-lib";
import { loadLocale, translate, translatePlural } from "./index";
import { pl } from "./locales/pl";
import { MESSAGES, type Message } from "./messages.generated";
import { LOCALES } from "./registry";

const TRANSLATED = LOCALES.filter((l) => l.code !== "en"); // English is the source — it has no dictionary

describe("i18n runtime", () => {
  it("English is the source: the message IS the answer, with {params} filled", () => {
    expect(translate("en", "Transactions")).toBe("Transactions");
    expect(translate("en", "Last sync: {rel}.", { rel: "just now" })).toBe("Last sync: just now.");
    expect(translatePlural("en", "{n} transaction | {n} transactions", 1)).toBe("1 transaction");
    expect(translatePlural("en", "{n} transaction | {n} transactions", 4)).toBe("4 transactions");
  });

  it("a loaded locale translates, and its plurals pick the CLDR category (pl: one/few/many)", async () => {
    await loadLocale("pl");
    expect(translate("pl", "Transactions")).toBe("Transakcje");
    expect(translatePlural("pl", "{n} transaction | {n} transactions", 1)).toBe("1 transakcja");
    expect(translatePlural("pl", "{n} transaction | {n} transactions", 3)).toBe("3 transakcje");
    expect(translatePlural("pl", "{n} transaction | {n} transactions", 5)).toBe("5 transakcji");
  });

  it("an untranslated language degrades to correct English (what makes partial locales usable)", async () => {
    await loadLocale("de"); // registered in Lang, not yet in LOCALES → no dictionary at all
    expect(translate("de", "Transactions")).toBe("Transactions");
    expect(translatePlural("de", "{n} transaction | {n} transactions", 2)).toBe("2 transactions");
  });
});

describe("i18n messages", () => {
  it("messages.generated.ts is up to date (run `bun run i18n:extract`)", async () => {
    expect(await extract()).toEqual([...MESSAGES]);
  });

  it("plural messages carry exactly one ' | ' separator (the English one/other source)", () => {
    for (const m of MESSAGES.filter((x) => x.includes(" | "))) {
      expect(m.split(" | ").length).toBe(2);
    }
  });

  it("no locale carries an orphaned message (copy changed → re-translate)", async () => {
    const known = new Set<string>(MESSAGES);
    for (const l of TRANSLATED) {
      const dict = await l.load();
      const orphans = Object.keys(dict).filter((k) => !known.has(k));
      expect({ locale: l.code, orphans }).toEqual({ locale: l.code, orphans: [] });
    }
  });

  it("every plural entry has the CLDR categories its language requires", async () => {
    for (const l of TRANSLATED) {
      const dict = await l.load();
      const need = new Intl.PluralRules(l.code).resolvedOptions().pluralCategories;
      for (const [message, value] of Object.entries(dict)) {
        if (typeof value === "string") continue;
        for (const cat of need) expect({ message, cat, has: cat in value }).toEqual({ message, cat, has: true });
      }
    }
  });

  it("a plural message is translated as forms, a singular one as a string (no shape mix-up)", async () => {
    for (const l of TRANSLATED) {
      const dict = await l.load();
      for (const [message, value] of Object.entries(dict)) {
        expect({ message, plural: message.includes(" | ") }).toEqual({ message, plural: typeof value === "object" });
      }
    }
  });
});

/**
 * Words the user must REPRODUCE on a keyboard rather than just read: an untypeable one is a hard
 * lock-out, not a cosmetic bug (the English dictionary once shipped the Polish literal
 * "WYŁĄCZ-E2EE", and Ł/Ą cannot be typed on a US layout — disabling E2EE was copy-paste-only).
 * The literal that goes on the WIRE is separate and fixed (E2EE_DISABLE_CONFIRM).
 */
describe("i18n — typed confirmation words", () => {
  const CONFIRM_WORDS: Message[] = ["DISABLE-E2EE", "DELETE"];

  it("the English words are printable ASCII (typeable on a US keyboard)", () => {
    for (const w of CONFIRM_WORDS) expect(w).toMatch(/^[\x20-\x7e]+$/);
  });

  it("every locale's words are UPPERCASE — the input is matched via .toUpperCase()", async () => {
    for (const l of TRANSLATED) {
      const dict = await l.load();
      for (const w of CONFIRM_WORDS) {
        const translated = dict[w];
        if (typeof translated !== "string") continue; // untranslated → the English word, already checked
        expect(translated).toBe(translated.toUpperCase());
      }
    }
  });

  it("the E2EE wire literal is locale-independent, not the localized word", () => {
    // Polish keeps its own word for the user to type; only the ASCII constant is POSTed.
    expect(pl["DISABLE-E2EE"]).toBe("WYŁĄCZ-E2EE");
    expect(E2EE_DISABLE_CONFIRM).toMatch(/^[\x20-\x7e]+$/);
  });
});
