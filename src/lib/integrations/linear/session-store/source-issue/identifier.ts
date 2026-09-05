export function sourceIssueIdentifierFromBranch(
  branchName: string | null | undefined,
): string | null {
  const match = branchName?.match(/(?:^|-)([a-z][a-z0-9]*)-(\d+)$/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}
