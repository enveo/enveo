import { describe, expect, it } from "bun:test";
import { createDefaultWideWidgets, WIDE_WIDGET_IDS, WIDGET_IDS, type WideWidgetId, type WidgetId } from "@enveo/shared";
import { isWideWidget, WIDGET_CATALOG } from "./widgetCatalog";

describe("WIDGET_CATALOG", () => {
  it("has an entry for every WidgetId (pins the Record at runtime for corrupted-data paths)", () => {
    for (const id of WIDGET_IDS) {
      expect(WIDGET_CATALOG[id]).toBeDefined();
      expect(WIDGET_CATALOG[id].id).toBe(id);
    }
  });

  it("derives `wide` from the shared WIDE_WIDGET_IDS allowlist — the two sources cannot drift", () => {
    const wideSet = new Set<WidgetId>(WIDE_WIDGET_IDS);
    for (const id of WIDGET_IDS) {
      expect(WIDGET_CATALOG[id].wide).toBe(wideSet.has(id));
    }
  });

  it("keeps quickActions/accounts phone-only (not wide-capable)", () => {
    expect(WIDGET_CATALOG.quickActions.wide).toBe(false);
    expect(WIDGET_CATALOG.accounts.wide).toBe(false);
  });

  it("every WidgetId is offered on the phone stack", () => {
    for (const id of WIDGET_IDS) {
      expect(WIDGET_CATALOG[id].phone).toBe(true);
    }
  });

  it("marks exactly {quickActions, accounts, envelopes} as configurable", () => {
    const expected = new Set<WidgetId>(["quickActions", "accounts", "envelopes"]);
    for (const id of WIDGET_IDS) {
      expect(WIDGET_CATALOG[id].configurable).toBe(expected.has(id));
    }
  });

  it("carries a picker description for exactly the wide-capable ids (owner round 6 item 28 — no bare title can reach the add-widget picker)", () => {
    for (const id of WIDGET_IDS) {
      const hasDescription = typeof WIDGET_CATALOG[id].description === "string" && WIDGET_CATALOG[id].description !== WIDGET_CATALOG[id].title;
      expect(hasDescription).toBe(WIDGET_CATALOG[id].wide);
    }
  });

  it("every default wide board id satisfies isWideWidget", () => {
    for (const widget of createDefaultWideWidgets()) {
      expect(isWideWidget(widget.id)).toBe(true);
    }
  });

  it("isWideWidget agrees with the shared allowlist for every WidgetId", () => {
    const wideSet = new Set<WideWidgetId>(WIDE_WIDGET_IDS);
    for (const id of WIDGET_IDS) {
      expect(isWideWidget(id)).toBe(wideSet.has(id as WideWidgetId));
    }
  });
});
