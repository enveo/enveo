/**
 * Guards on the CONFIRMATION WORDS the user has to type by hand (E2EE disable, server wipe).
 *
 * These are the only UI strings a user must REPRODUCE on a keyboard rather than just read, so an
 * untypeable one is a hard lock-out, not a cosmetic bug: the English dictionary once shipped the
 * Polish literal "WYŁĄCZ-E2EE", and Ł/Ą cannot be typed on a US layout — disabling E2EE was
 * copy-paste-only. The literal that goes on the WIRE is separate and fixed (E2EE_DISABLE_CONFIRM).
 */
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { describe, expect, it } from "bun:test";
import { en } from "./i18n.en";
import { pl } from "./i18n.pl";

/** Words the user must TYPE to confirm a destructive action. */
const CONFIRM_WORD_KEYS = ["e2ee.disableWord", "settings.wipeConfirmWord"] as const;

describe("i18n — typed confirmation words", () => {
  it("the English words are printable ASCII (typeable on a US keyboard)", () => {
    for (const key of CONFIRM_WORD_KEYS) {
      expect(en[key]).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("every locale's words are UPPERCASE — the input is matched via .toUpperCase()", () => {
    for (const dict of [pl, en]) {
      for (const key of CONFIRM_WORD_KEYS) {
        expect(dict[key]).toBe(dict[key].toUpperCase());
      }
    }
  });

  it("the E2EE wire literal is locale-independent, not the localized word", () => {
    // Polish keeps its own word for the user to type; only the ASCII constant is POSTed.
    expect(pl["e2ee.disableWord"]).toBe("WYŁĄCZ-E2EE");
    expect(E2EE_DISABLE_CONFIRM).toMatch(/^[\x20-\x7e]+$/);
  });
});
