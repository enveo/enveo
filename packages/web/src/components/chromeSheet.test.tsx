import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sheet } from "./chrome";

const sheetBody = (html: string) => html.match(/<div class="gs"[^>]*>/)?.[0] ?? "";

describe("Sheet placement", () => {
  it("is a phone-width column centred on the screen without an anchor", () => {
    // when
    const body = sheetBody(
      renderToStaticMarkup(
        <Sheet show onClose={() => {}}>
          Pad
        </Sheet>,
      ),
    );

    // then
    expect(body).toContain("margin:0 auto");
    expect(body).toContain("max-width:420px");
  });

  it("docks across the anchored pane in wide layouts instead of a small centred column", () => {
    // given: the side panel of a foldable layout
    const anchor = { left: 548, width: 556 };

    // when
    const body = sheetBody(
      renderToStaticMarkup(
        <Sheet show onClose={() => {}} anchor={anchor}>
          Pad
        </Sheet>,
      ),
    );

    // then
    expect(body).toContain("left:548px;width:556px");
    expect(body).not.toContain("max-width");
    expect(body).not.toContain("margin:0 auto");
  });
});
