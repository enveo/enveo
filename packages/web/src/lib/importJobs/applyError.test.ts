import { describe, expect, it } from "bun:test";
import type { Message } from "../i18n";
import { pl } from "../i18n/locales/pl";
import { importApplyErrorMessage } from "./applyError";

describe("import apply errors", () => {
  it("asks the user to complete selected incomplete rows", () => {
    expect(importApplyErrorMessage(new Error("import_review_incomplete"), (message) => message)).toBe(
      "Complete or uncheck the unfinished rows before adding transactions.",
    );
  });
  it("turns unsupported cross-tab locking into actionable localized review guidance", () => {
    const translate = (message: Message) => {
      const translated = pl[message];
      return typeof translated === "string" ? translated : message;
    };

    expect(importApplyErrorMessage(new Error("import_web_locks_unavailable"), translate)).toBe(
      "Ta przeglądarka nie może bezpiecznie koordynować zmian importu między kartami. Pozostaw ten przegląd otwarty i spróbuj ponownie w obsługiwanej przeglądarce.",
    );
  });

  it("keeps the standard API error mapping for unrelated failures", () => {
    expect(importApplyErrorMessage(new Error("ai_unavailable"), (message) => message)).toBe(
      "The server has no OpenAI key configured — server mode is unavailable. Use an existing own key or keep AI on rules.",
    );
  });
});
