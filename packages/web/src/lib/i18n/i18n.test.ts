/**
 * The message IS the key, so the dictionary cannot drift silently — these tests are what makes the
 * pattern safe:
 *
 *  - messages.generated.ts must match the source (it types every t() call site);
 *  - a locale may not carry an ORPHAN — editing an English string changes its key, which silently
 *    invalidates that string's translations. The orphan list names exactly what to re-translate;
 *  - plural entries must carry the CLDR categories their language requires (computed, never
 *    hand-written);
 *  - a message must be a WHOLE phrase (fragments glued in JSX force English word order and hide the
 *    context a translator needs), and a translation must keep its {placeholders};
 *  - and the words a user must TYPE to confirm a destructive action must stay typeable.
 */
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { describe, expect, it } from "bun:test";
import { ambiguous, extract, extractSites } from "../../../scripts/i18n-extract-lib";
import { loadLocale, translate, translatePlural, type Dict, type Lang } from "./index";
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

  it("a message MISSING from a locale degrades to correct English (what makes partial locales usable)", async () => {
    // Dict is Partial by design: a community locale may cover 3 messages or 600, and every gap
    // renders the English source rather than a key or a blank. Deliberately NOT asserted against a
    // shipped locale — those are complete today, so they could only prove this by regressing.
    const code = "zy" as Lang; // never in the registry: no future locale can shadow this test
    const entry = {
      code,
      endonym: "Test",
      community: true,
      load: async (): Promise<Dict> => ({ Transactions: "Zy" }), // one message; everything else absent
    };
    LOCALES.unshift(entry);
    try {
      await loadLocale(code);
      expect(translate(code, "Transactions")).toBe("Zy"); // present → translated
      expect(translate(code, "Settings")).toBe("Settings"); // absent → English source
      expect(translatePlural(code, "{n} transaction | {n} transactions", 2)).toBe("2 transactions");
    } finally {
      LOCALES.splice(LOCALES.indexOf(entry), 1);
    }
  });

  it("every shipped locale is wired up: translate() returns that locale's dictionary entry", async () => {
    // NOT "differs from English" — French for "Transactions" is "Transactions", and a locale is not
    // broken for agreeing with the source. What must hold is that the registry's chunk is the thing
    // translate() reads from.
    for (const l of TRANSLATED) {
      const dict = await l.load();
      await loadLocale(l.code);
      expect({ locale: l.code, out: translate(l.code, "Settings") }).toEqual({ locale: l.code, out: dict["Settings"] as string });
    }
  });

  it("a locale chunk that FAILS to load degrades to English instead of rejecting (no blank boot)", async () => {
    // main.tsx renders only once loadLocale settles, and Appearance.tsx switches the language only
    // once it settles. So a rejected chunk fetch (network blip on a first load before the service
    // worker precaches, an SW-less context, a 404 on the hashed asset) would be a permanent WHITE
    // SCREEN for translated users — not a missing translation. The failure must not be cached either.
    const code = "zz" as Lang; // never in the registry: no future locale can shadow this test
    let attempts = 0;
    const entry = {
      code,
      endonym: "Test",
      community: true,
      load: () =>
        ++attempts === 1 ? Promise.reject(new Error("chunk 404")) : Promise.resolve({ Transactions: "Zz" } as Dict),
    };
    LOCALES.unshift(entry);
    try {
      await loadLocale(code); // must RESOLVE, not throw
      expect(translate(code, "Transactions")).toBe("Transactions"); // English source

      await loadLocale(code); // the failure was not cached → a later attempt still loads
      expect(translate(code, "Transactions")).toBe("Zz");
    } finally {
      LOCALES.splice(LOCALES.indexOf(entry), 1);
    }
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

  /**
   * A message must be a WHOLE phrase, never a fragment glued to another one in JSX. Fragments carry
   * English word order into every language and strip the translator of context — that is how the
   * three-part "Type" + <b>DELETE</b> + " to confirm:" prompt above the destructive confirmations
   * shipped with "Type" read as a NOUN ("Typ", "Tipo") in 7 of 8 locales. The fix is always the
   * same: ONE message with a {placeholder} (see ConfirmWordHint in screens/settings/ui.tsx), which
   * lets German put its separable prefix last and Czech lead with the adverbial.
   *
   * Leading/trailing whitespace is the mechanical tell of concatenation, so it is banned outright.
   */
  it("no message is a FRAGMENT (leading/trailing whitespace = glued to another message)", () => {
    const fragments = MESSAGES.filter((m) => m !== m.trim());
    expect(fragments).toEqual([]);
  });

  /** Placeholders must survive translation: a dropped {word} hides the very word the user must type
   *  to confirm a destructive action (a lock-out, not a cosmetic bug); a dropped {n} loses the count. */
  it("every translation keeps exactly the placeholders of its message", async () => {
    const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    for (const l of TRANSLATED) {
      const dict = await l.load();
      for (const [message, value] of Object.entries(dict)) {
        const want = placeholders(message); // a plural key repeats {n} in both halves — compare SETS
        const forms = typeof value === "string" ? { other: value } : value;
        for (const [cat, form] of Object.entries(forms)) {
          expect({ locale: l.code, message, cat, placeholders: placeholders(form as string) }).toEqual({ locale: l.code, message, cat, placeholders: want });
        }
      }
    }
  });
});

/**
 * The design's §2 ambiguity report: SHORT messages reused at several call sites, where one
 * translation has to serve every context (the "Save" verb/noun trap). It is a WARNING — most hits
 * are honest nouns — so it is a script (`bun run i18n:ambiguity`), not a gate. These tests keep the
 * detector itself honest.
 */
describe("i18n — ambiguity report", () => {
  it("flags a short message reused across call sites, and ignores a whole sentence", () => {
    const report = ambiguous(
      new Map([
        ["Type", ["a.tsx:1", "b.tsx:2"]], // bare word, two contexts → the trap
        ["Transactions", ["a.tsx:3"]], // one call site → one context
        ["Delete everything and start over", ["a.tsx:4", "b.tsx:5"]], // a sentence carries its context
      ]),
    );
    expect(report.map((r) => r.message)).toEqual(["Type"]);
  });

  it("reports every candidate with the call sites that need a human decision", async () => {
    for (const { message, sites } of ambiguous(await extractSites())) {
      expect({ message, sites: sites.length > 1 }).toEqual({ message, sites: true });
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
  // EVERY word compared with `input.trim().toUpperCase() !== t(word)`. Keep this list exhaustive —
  // grep `toUpperCase` in packages/web/src: Advanced.tsx ("DELETE", "RESET") and
  // DataSection.tsx ("DISABLE-E2EE"). A word missing from here is a lock-out waiting for a locale.
  const CONFIRM_WORDS: Message[] = ["DISABLE-E2EE", "DELETE", "RESET"];

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
