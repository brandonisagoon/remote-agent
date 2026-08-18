import { describe, expect, test } from "bun:test";

import { productLabelSnippets } from "./product-labels.ts";

describe("Product label snippet selection", () => {
  test.each([
    ["Bug", "product-label-bug"],
    ["Feature", "product-label-feature"],
    ["UI", "product-label-ui"],
    ["Performance", "product-label-performance"],
    ["Technical Debt", "product-label-technical-debt"],
    ["Dev Ops", "product-label-dev-ops"],
  ])("maps Product > %s", (name, snippet) => {
    expect(
      productLabelSnippets([{ name, parent: { name: "Product" } }]),
    ).toEqual([snippet]);
  });

  test("ignores same-named labels outside Product", () => {
    expect(
      productLabelSnippets([
        { name: "Bug", parent: null },
        { name: "Feature", parent: { name: "Engineering" } },
      ]),
    ).toEqual([]);
  });

  test("deduplicates and sorts combined selections", () => {
    expect(
      productLabelSnippets([
        { name: "UI", parent: { name: "Product" } },
        { name: "Bug", parent: { name: "Product" } },
        { name: "UI", parent: { name: "Product" } },
      ]),
    ).toEqual(["product-label-bug", "product-label-ui"]);
  });

  test("fails explicitly for an unsupported Product child", () => {
    expect(() =>
      productLabelSnippets([
        { name: "New Kind", parent: { name: "Product" } },
      ]),
    ).toThrow("unsupported Product label: New Kind");
  });
});
