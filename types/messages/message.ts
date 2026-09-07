export interface MessageContext {
  quotedText?: string | null;
  parentBody?: string | null;
  parentAuthor?: string | null;
}

export interface Message {
  sourceIssueIdentifier: string;
  authorName: string | null;
  body: string;
  context?: MessageContext;
}
