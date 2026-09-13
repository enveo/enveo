import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importJobManager } from "../lib/importJobs/manager";
import { importActivityFromDraft } from "../lib/importJobs/store";
import { ImportActivityBadge } from "./ImportActivityBadge";

it("names the header action and drawer status, and hides both when no import needs attention", () => {
  const item = importActivityFromDraft({
    id: "import",
    ownerId: "owner",
    requestHash: "0".repeat(64),
    uploadAttemptedAt: null,
    cancelRequestedAt: null,
    budgetId: "budget",
    accountId: "account",
    locale: "en",
    images: [],
    createdAt: "",
    updatedAt: "",
    expiresAt: "",
  });
  item.status = "ready";
  const items = spyOn(importJobManager, "activityItems").mockReturnValue([item]);
  try {
    const header = renderToStaticMarkup(createElement(ImportActivityBadge, { onOpen: () => {} }));
    expect(header).toContain('<button type="button"');
    expect(header).toContain('aria-label="1 import needs attention — open Imports"');
    expect(header).toContain(">1</button>");
    const drawer = renderToStaticMarkup(createElement(ImportActivityBadge));
    expect(drawer).toContain('<span role="img" aria-label="1 import needs attention"');
    expect(drawer).toContain(">1</span>");
    expect(drawer).not.toContain("<button");
    items.mockReturnValue([]);
    expect(renderToStaticMarkup(createElement(ImportActivityBadge))).toBe("");
    expect(renderToStaticMarkup(createElement(ImportActivityBadge, { onOpen: () => {} }))).toBe("");
  } finally {
    items.mockRestore();
  }
});
