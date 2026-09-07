/** Renders the repository's branch template from provider facts. The
    provider supplies the facts; the repository owns the convention; the
    server never invents names — an empty render (e.g. "{branch}" from a
    provider with no native branch names) returns null and the launch fails
    with the contract message. */
export function renderBranchName(
  template: string,
  facts: { branch?: string | null; issue: string; title?: string | null },
): string | null {
  const rendered = template
    .replaceAll("{branch}", facts.branch?.trim() ?? "")
    .replaceAll("{issue}", facts.issue.toLowerCase())
    .replaceAll("{title}", slugify(facts.title ?? ""))
    // Collapse separators left behind by empty placeholders.
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return rendered.length > 0 ? rendered : null;
}

/** Renders the worktree directory template from the same provider facts as
    the branch template — deliberately self-contained, not chained to the
    rendered branch. Substituted VALUES are made path-friendly (slashes and
    spaces to hyphens); template literals pass through untouched. An empty
    render falls back to the flattened fallback branch — the directory must
    always exist. */
export function renderWorktreeName(
  template: string,
  facts: { branch?: string | null; issue: string; title?: string | null },
  fallbackBranch: string,
): string {
  const pathSafe = (value: string) => value.replaceAll("/", "-").replaceAll(" ", "-");
  const rendered = template
    .replaceAll("{branch}", pathSafe(facts.branch?.trim() ?? ""))
    .replaceAll("{issue}", facts.issue.toLowerCase())
    .replaceAll("{title}", slugify(facts.title ?? ""))
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return rendered || pathSafe(fallbackBranch);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function isSafeBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) {
    return false;
  }
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
}
