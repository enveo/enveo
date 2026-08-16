import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountListRowContent } from "../screens/AccountListRowContent";

it("keeps a closed long account and automatic-envelope label inside the shrinkable row", () => {
  const html = renderToStaticMarkup(
    createElement(AccountListRowContent, {
      account: {
        name: "A very long closed account name that must not displace its balance",
        color: "#123456",
        icon: "wallet",
        balance: 123_456_78,
      },
      automaticLabel: "Automatic: A very long envelope name that must also truncate",
      balanceText: "€123,456.78",
      compact: true,
      colors: { text: "#111", soft: "#222", mute: "#333" },
    }),
  );

  expect(html).toContain('data-account-row-content="closed"');
  expect((html.match(/min-width:0/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect((html.match(/text-overflow:ellipsis/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect((html.match(/flex-shrink:0/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(html).toContain("Automatic: A very long envelope name");
});
