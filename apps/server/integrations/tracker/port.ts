import * as linear from "../linear/index.ts";

/** Environment-driven workflow triggers consumed by the tracker adapter. */
export interface TrackerTriggerConfig {
  endOnState: string;
}

/**
 * Tracker capabilities used by the control plane.
 *
 * Linear is the only implementation today. Keeping the surface structural
 * makes the adoption contract explicit without pretending a second adapter
 * exists or forcing the workers to import Linear modules directly.
 */
export interface TrackerPort {
  verifyWebhookSignature: typeof linear.verifyLinearSignature;
  webhook: {
    envelopeSchema: typeof linear.LinearWebhookEnvelopeSchema;
    commentSchema: typeof linear.LinearCommentWebhookSchema;
    issueSchema: typeof linear.LinearIssueWebhookSchema;
    reactionSchema: typeof linear.LinearReactionWebhookSchema;
    handleComment: typeof linear.handleCommentWebhook;
    handleIssue: typeof linear.handleIssueWebhook;
    handleReaction: typeof linear.handleReactionWebhook;
  };
  comments: {
    create: typeof linear.createIssueComment;
    createThreaded: typeof linear.createThreadedIssueComment;
    fetchBody: typeof linear.fetchIssueCommentBody;
    contains: typeof linear.issueHasCommentContaining;
    update: typeof linear.updateIssueComment;
  };
  reactions: {
    values: typeof linear.TrackerReaction;
    comment: typeof linear.reactToComment;
    issue: typeof linear.reactToIssue;
  };
  mentions: {
    matchesAgent: typeof linear.mentionsAgent;
    fetchContext: typeof linear.fetchCommentContext;
  };
  sessions: {
    createAgentIssue: typeof linear.createAgentIssue;
    createAgentIssueRelation: typeof linear.createAgentIssueRelation;
    deleteAgentIssueRelation: typeof linear.deleteAgentIssueRelation;
    getAgentCatalog: typeof linear.getAgentCatalog;
    getAgentIssue: typeof linear.getAgentIssue;
    getAgentIssueRelations: typeof linear.getAgentIssueRelations;
    getAgentIssues: typeof linear.getAgentIssues;
    getAgentStateId: typeof linear.getAgentStateId;
    getSourceIssue: typeof linear.getSourceIssue;
    getSourceIssueWithAgentIssues: typeof linear.getSourceIssueWithAgentIssues;
    updateAgentIssue: typeof linear.updateAgentIssue;
  };
  triggers: (config: TrackerTriggerConfig) => TrackerTriggerConfig;
}

export const tracker: TrackerPort = {
  verifyWebhookSignature: linear.verifyLinearSignature,
  webhook: {
    envelopeSchema: linear.LinearWebhookEnvelopeSchema,
    commentSchema: linear.LinearCommentWebhookSchema,
    issueSchema: linear.LinearIssueWebhookSchema,
    reactionSchema: linear.LinearReactionWebhookSchema,
    handleComment: linear.handleCommentWebhook,
    handleIssue: linear.handleIssueWebhook,
    handleReaction: linear.handleReactionWebhook,
  },
  comments: {
    create: linear.createIssueComment,
    createThreaded: linear.createThreadedIssueComment,
    fetchBody: linear.fetchIssueCommentBody,
    contains: linear.issueHasCommentContaining,
    update: linear.updateIssueComment,
  },
  reactions: {
    values: linear.TrackerReaction,
    comment: linear.reactToComment,
    issue: linear.reactToIssue,
  },
  mentions: {
    matchesAgent: linear.mentionsAgent,
    fetchContext: linear.fetchCommentContext,
  },
  sessions: {
    createAgentIssue: linear.createAgentIssue,
    createAgentIssueRelation: linear.createAgentIssueRelation,
    deleteAgentIssueRelation: linear.deleteAgentIssueRelation,
    getAgentCatalog: linear.getAgentCatalog,
    getAgentIssue: linear.getAgentIssue,
    getAgentIssueRelations: linear.getAgentIssueRelations,
    getAgentIssues: linear.getAgentIssues,
    getAgentStateId: linear.getAgentStateId,
    getSourceIssue: linear.getSourceIssue,
    getSourceIssueWithAgentIssues: linear.getSourceIssueWithAgentIssues,
    updateAgentIssue: linear.updateAgentIssue,
  },
  triggers: (config) => ({ ...config }),
};
