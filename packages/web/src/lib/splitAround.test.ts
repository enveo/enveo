import { describe, expect, it } from "bun:test";
import { splitAround } from "../screens/settings/ui";

/**
 * The shared NUL-sentinel placeholder split (M3) — used by ConfirmWordHint ("Type {word}
 * to confirm:") and InstallBody's iOS steps ("Tap {action} to continue"). The caller renders
 * its own element between the halves; the helper must keep the WHOLE translated phrase
 * intact and only ever degrade to [sentence + " ", ""] — never to glued fragments.
 */
describe("splitAround", () => {
  const MARK = "\u0000";

  it("splits the translated sentence around the mark", () => {
    expect(splitAround(`Tap ${MARK} to continue`, MARK)).toEqual(["Tap ", " to continue"]);
  });

  it("keeps empty halves at the edges (verb-final and verb-first languages)", () => {
    expect(splitAround(`${MARK} antippen`, MARK)).toEqual(["", " antippen"]);
    expect(splitAround(`Toque em ${MARK}`, MARK)).toEqual(["Toque em ", ""]);
  });

  it("a translation that dropped the placeholder degrades to sentence + trailing space", () => {
    // The element (bold word / icon) still renders, after the text — a lock-out (hiding the
    // word the user must type) is the failure mode this guards against.
    expect(splitAround("Tap to continue", MARK)).toEqual(["Tap to continue ", ""]);
  });

  it("a duplicated placeholder degrades the same way instead of dropping text silently", () => {
    expect(splitAround(`a${MARK}b${MARK}c`, MARK)).toEqual(["a ", ""]);
  });

  it("empty input degrades safely", () => {
    expect(splitAround("", MARK)).toEqual([" ", ""]);
  });
});
