import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomaticEnvelopeEffect } from "./AutomaticEnvelopeEffect";

describe("AutomaticEnvelopeEffect", () => {
  it("renders only the callback-free formatted effect data it receives", () => {
    // given: the controller already localized and formatted every displayed value
    const data = {
      heading: "Automatic envelope effect",
      rows: [{ name: "Savings", amount: "+100 EUR", tone: "positive" as const }],
      readyToAssign: { name: "Ready to assign", amount: "−100 EUR", tone: "negative" as const },
      neutral: false,
      noEnvelopeChange: "No envelope change",
    };

    // when: the presentational card renders
    const html = renderToStaticMarkup(createElement(AutomaticEnvelopeEffect, { data }));

    // then: envelope and Ready effects are visible without any ledger input or callback
    expect(html).toContain("Automatic envelope effect");
    expect(html).toContain("Savings");
    expect(html).toContain("+100 EUR");
    expect(html).toContain("Ready to assign");
    expect(html).toContain("−100 EUR");
  });

  it("renders an explicit no-envelope-change state for a neutral route", () => {
    // given: the shared resolver determined that both transfer sides use one envelope
    const data = {
      heading: "Automatic envelope effect",
      rows: [],
      readyToAssign: { name: "Ready to assign", amount: "No change", tone: "neutral" as const },
      neutral: true,
      noEnvelopeChange: "No envelope change",
    };

    // when: the neutral card renders
    const html = renderToStaticMarkup(createElement(AutomaticEnvelopeEffect, { data }));

    // then: the neutral outcome is stated directly instead of showing empty rows
    expect(html).toContain("No envelope change");
    expect(html).not.toContain("Ready to assign");
  });
});
