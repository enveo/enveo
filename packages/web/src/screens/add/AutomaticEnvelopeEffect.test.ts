import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomaticEnvelopeEffect } from "./AutomaticEnvelopeEffect";

describe("AutomaticEnvelopeEffect", () => {
  it("renders only the callback-free formatted effect data it receives", () => {
    const data = {
      heading: "Automatic envelope effect",
      rows: [{ name: "Savings", amount: "+100 EUR", tone: "positive" as const }],
      readyToAssign: { name: "Ready to assign", amount: "−100 EUR", tone: "negative" as const },
      neutral: false,
      noEnvelopeChange: "No envelope change",
    };

    const html = renderToStaticMarkup(createElement(AutomaticEnvelopeEffect, { data }));

    expect(html).toContain("Automatic envelope effect");
    expect(html).toContain("Savings");
    expect(html).toContain("+100 EUR");
    expect(html).toContain("Ready to assign");
    expect(html).toContain("−100 EUR");
  });

  it("renders an explicit no-envelope-change state for a neutral route", () => {
    const data = {
      heading: "Automatic envelope effect",
      rows: [],
      readyToAssign: { name: "Ready to assign", amount: "No change", tone: "neutral" as const },
      neutral: true,
      noEnvelopeChange: "No envelope change",
    };

    const html = renderToStaticMarkup(createElement(AutomaticEnvelopeEffect, { data }));

    expect(html).toContain("No envelope change");
    expect(html).not.toContain("Ready to assign");
  });
});
