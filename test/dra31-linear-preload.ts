/**
 * DRA-31 test-only synthetic Linear transport, loaded into the isolated real
 * server by `isolatedServer({ preload })`
 * (`bun --no-env-file --preload <this file> apps/server/server.ts`).
 *
 * Every request to a *.linear.app host is intercepted; nothing reaches the
 * real network. Only POST https://api.linear.app/graphql operations named in
 * OPERATIONS are answered, from fixture-scripted private state; OAuth and
 * every other Linear request or operation is refused and logged. Other hosts
 * use the original fetch unchanged.
 *
 * Private files live next to the isolated config (dirname(REMOTE_AGENT_CONFIG)):
 *   linear-state.json      scripted by the rehearsal (credential, users, issues, comments)
 *   linear-requests.jsonl  every intercepted request and its outcome
 *   linear-created.jsonl   comments/reactions the server created through this transport
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const config = process.env.REMOTE_AGENT_CONFIG;
if (!config) throw new Error("The synthetic Linear preload requires the isolated REMOTE_AGENT_CONFIG");
const directory = path.dirname(config);
const statePath = path.join(directory, "linear-state.json");
const requestLog = path.join(directory, "linear-requests.jsonl");
const createdLog = path.join(directory, "linear-created.jsonl");

type Issue = { id: string; identifier: string; title: string; description: string | null; branchName: string; createdAt: string; updatedAt: string;
  state: { id: string; name: string; type: string }; team: { id: string; key: string } };
type Comment = { id: string; issueId: string; body: string; parentId: string | null; userId: string | null; createdAt: string; updatedAt: string };
type Reaction = { id: string; emoji: string; userId: string; commentId?: string; issueId?: string };
type State = { credential: string; organizationId: string; agentUserId: string; issues: Issue[]; comments: Comment[] };

// Entities this transport created for the server (in-process overlay).
const created: { comments: Comment[]; reactions: Reaction[] } = { comments: [], reactions: [] };
const log = (file: string, value: object) => appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 });
const state = (): State => {
  const scripted = JSON.parse(readFileSync(statePath, "utf8")) as State;
  return { ...scripted, comments: [...scripted.comments, ...created.comments] };
};
const findIssue = (current: State, reference: unknown) => current.issues.find(issue => issue.id === reference || issue.identifier === reference) ?? null;
const commentNode = (current: State, comment: Comment) => {
  const issue = current.issues.find(candidate => candidate.id === comment.issueId)!;
  return { id: comment.id, body: comment.body, parentId: comment.parentId, createdAt: comment.createdAt, updatedAt: comment.updatedAt, editedAt: null, quotedText: null,
    user: comment.userId ? { id: comment.userId } : null, issue: { id: issue.id, identifier: issue.identifier, title: issue.title }, documentContent: null,
    reactions: created.reactions.filter(reaction => reaction.commentId === comment.id).map(reaction => ({ id: reaction.id, emoji: reaction.emoji, user: { id: reaction.userId } })) };
};
const issueNode = (current: State, issue: Issue | null) => issue && ({
  id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description, branchName: issue.branchName, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  state: issue.state, team: { id: issue.team.id, key: issue.team.key, organization: { id: current.organizationId }, states: { nodes: [issue.state] } },
  labels: { nodes: [] }, project: null, parent: null, children: { nodes: [], pageInfo: { hasNextPage: false } }, relations: { nodes: [] }, inverseRelations: { nodes: [] },
  attachments: { nodes: [] },
  comments: { nodes: current.comments.filter(comment => comment.issueId === issue.id).map(comment => commentNode(current, comment)), pageInfo: { hasNextPage: false } },
});
const findComment = (current: State, id: unknown) => current.comments.find(comment => comment.id === id) ?? null;
const issueQuery = (variables: Record<string, unknown>) => { const current = state(); return { issue: issueNode(current, findIssue(current, variables.id ?? variables.issueId)) }; };
const commentQuery = (variables: Record<string, unknown>) => { const current = state(); const comment = findComment(current, variables.id ?? variables.commentId); return { comment: comment && commentNode(current, comment) }; };
const createComment = (input: { issueId: string; body: string; parentId?: string; id?: string }) => {
  const current = state();
  if (!findIssue(current, input.issueId)) throw new Error(`Unknown synthetic issue ${input.issueId}`);
  const at = new Date().toISOString();
  const comment: Comment = { id: input.id ?? crypto.randomUUID(), issueId: findIssue(current, input.issueId)!.id, body: input.body, parentId: input.parentId ?? null, userId: current.agentUserId, createdAt: at, updatedAt: at };
  created.comments.push(comment); log(createdLog, { kind: "comment", comment });
  return { commentCreate: { success: true, comment: { id: comment.id } } };
};
const react = (target: { commentId?: string; issueId?: string }, emoji: string) => {
  const reaction: Reaction = { id: crypto.randomUUID(), emoji, userId: state().agentUserId, ...target };
  created.reactions.push(reaction); log(createdLog, { kind: "reaction", reaction });
  return { reactionCreate: { success: true } };
};

/** The explicit synthetic operation set. Anything else is refused. */
const OPERATIONS: Record<string, (variables: Record<string, any>) => unknown> = {
  SourceIssueForWorkflow: issueQuery, SourceIssue: issueQuery, SourceIssueParent: issueQuery, SourceIssueForRouting: issueQuery,
  RoutingIssue: issueQuery, IssueCommentTimeline: issueQuery, IssueComments: issueQuery,
  AcceptedComment: variables => ({ organization: { id: state().organizationId }, ...commentQuery(variables) }),
  DeliveryComment: commentQuery, IssueCommentBody: commentQuery, DeliveryReactions: commentQuery, CommentContext: commentQuery,
  QuestionComment: commentQuery,
  CreateIssueComment: variables => createComment({ issueId: variables.issueId, body: variables.body }),
  CreateThreadedIssueComment: variables => createComment(variables.input),
  UpdateIssueComment: variables => {
    const comment = created.comments.find(candidate => candidate.id === variables.commentId);
    if (!comment) return { commentUpdate: { success: false } };
    comment.body = variables.body; comment.updatedAt = new Date().toISOString(); log(createdLog, { kind: "comment-update", comment });
    return { commentUpdate: { success: true } };
  },
  CreateReaction: variables => react({ commentId: variables.commentId }, variables.emoji),
  CreateIssueReaction: variables => react({ issueId: variables.issueId }, variables.emoji),
  DeliveryReaction: variables => react({ commentId: variables.input.commentId }, variables.input.emoji),
  RemoveDeliveryReaction: variables => {
    const index = created.reactions.findIndex(reaction => reaction.id === variables.id);
    if (index >= 0) log(createdLog, { kind: "reaction-delete", reaction: created.reactions.splice(index, 1)[0] });
    return { reactionDelete: { success: index >= 0 } };
  },
};
// Linear's exact missing-Comment lookup failure (the only absence proof
// fetchIssueCommentIdentity accepts before reusing a client-assigned ID).
const MISSING_COMMENT = { data: null, errors: [{ message: "Entity not found: Comment", path: ["comment"],
  extensions: { type: "invalid input", code: "INPUT_ERROR", statusCode: 400, userError: true, userPresentableMessage: "Could not find referenced Comment." } }] };

const original = globalThis.fetch;
const synthetic = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) return original(input as Parameters<typeof fetch>[0], init);
  const refuse = (reason: string, extra: object = {}) => { log(requestLog, { outcome: "refused", reason, method: request.method, url: `${url.origin}${url.pathname}`, ...extra }); throw new TypeError(`DRA-31 synthetic Linear refused ${reason}`); };
  if (request.method !== "POST" || url.href !== "https://api.linear.app/graphql") return refuse("non-GraphQL Linear request");
  const current = state();
  if (request.headers.get("authorization") !== current.credential) return refuse("unexpected credential");
  const body = await request.json() as { query?: string; variables?: Record<string, unknown> };
  const operation = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(body.query ?? "")?.[1] ?? null;
  const variables = body.variables ?? {};
  const handler = operation ? OPERATIONS[operation] : undefined;
  if (!handler) {
    log(requestLog, { outcome: "refused", reason: "unknown operation", operation, variables });
    return Response.json({ errors: [{ message: `DRA-31 synthetic Linear refused unknown operation ${operation}` }] }, { status: 400 });
  }
  if (operation === "QuestionComment" && !findComment(current, variables.commentId)) {
    log(requestLog, { outcome: "answered", operation, variables, missing: true });
    return Response.json(MISSING_COMMENT);
  }
  try {
    const data = handler(variables);
    log(requestLog, { outcome: "answered", operation, variables });
    return Response.json({ data });
  } catch (error) {
    log(requestLog, { outcome: "failed", operation, variables, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ errors: [{ message: error instanceof Error ? error.message : String(error) }] }, { status: 400 });
  }
};
globalThis.fetch = Object.assign(synthetic, { preconnect: original.preconnect }) as typeof fetch;
log(requestLog, { outcome: "loaded", pid: process.pid, operations: Object.keys(OPERATIONS) });
