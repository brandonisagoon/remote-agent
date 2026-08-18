export function buildReplyDirective(
  cubeIssueIdentifier: string,
  threadRootCommentId: string,
): string {
  return `[Reply requested] When you have the answer, post it as a Linear comment on ${cubeIssueIdentifier} in the existing thread: call save_comment with parentId "${threadRootCommentId}" so it threads correctly. Do not create a new top-level comment and do not @mention the agent handle in your reply.`;
}
