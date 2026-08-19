const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export function buildDescribeSessionName(issueIdentifier: string): string {
  if (!ISSUE_IDENTIFIER_PATTERN.test(issueIdentifier)) {
    throw new Error(`Invalid issue identifier: ${issueIdentifier}`);
  }
  return `tracker-describe-${issueIdentifier.toLowerCase()}`;
}
