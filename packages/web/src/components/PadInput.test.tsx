import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InWideShell, type WideHostInfo } from "../lib/shellContext";
import { PadInput } from "./PadInput";

const target = () => ({ label: "Health", initial: 2500, onCommit: () => {} });
const shell = (mode: WideHostInfo["mode"]): WideHostInfo => ({
  host: "panel",
  mode,
  rects: { primary: { left: 68, width: 484 }, panel: { left: 552, width: 552 } },
});

describe("PadInput", () => {
  it("is a read-only field that opens the pad on a phone", () => {
    // when
    const html = renderToStaticMarkup(<PadInput value="25" target={target} onPad={() => {}} aria-label="Amount from Health" />);

    // then
    expect(html).toContain("readonly");
    expect(html).not.toContain('inputMode="decimal"');
  });

  it("is a read-only field that opens the docked pad on a foldable", () => {
    const html = renderToStaticMarkup(
      <InWideShell.Provider value={shell("fold")}>
        <PadInput value="25" target={target} onPad={() => {}} aria-label="Amount from Health" />
      </InWideShell.Provider>,
    );

    expect(html).toContain("readonly");
  });

  it("is typed in directly on desktop, with a decimal keyboard and no pad", () => {
    const html = renderToStaticMarkup(
      <InWideShell.Provider value={shell("desktop")}>
        <PadInput value="25" target={target} onPad={() => {}} aria-label="Amount from Health" />
      </InWideShell.Provider>,
    );

    expect(html).not.toContain("readonly");
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="25"');
  });
});
