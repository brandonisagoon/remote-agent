export function cubeIssueIdentifierFromBranch(
  branchName: string | null | undefined,
): string | null {
  const match = branchName?.match(/(?:^|-)cube-(\d+)$/i);
  return match ? `CUBE-${match[1]}` : null;
}
