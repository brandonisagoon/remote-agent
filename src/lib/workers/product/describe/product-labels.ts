const PRODUCT_LABEL_SNIPPETS: Record<string, string> = {
  Bug: "product-label-bug",
  Feature: "product-label-feature",
  UI: "product-label-ui",
  Performance: "product-label-performance",
  "Technical Debt": "product-label-technical-debt",
  "Dev Ops": "product-label-dev-ops",
};

export interface ProductLabelRef {
  name: string;
  parent: { name: string } | null;
}

export function productLabelSnippets(
  labels: readonly ProductLabelRef[],
): string[] {
  const snippets = new Set<string>();
  for (const label of labels) {
    if (label.parent?.name !== "Product") continue;
    const snippet = PRODUCT_LABEL_SNIPPETS[label.name];
    if (!snippet) {
      throw new Error(`unsupported Product label: ${label.name}`);
    }
    snippets.add(snippet);
  }
  return [...snippets].sort((left, right) => left.localeCompare(right));
}
