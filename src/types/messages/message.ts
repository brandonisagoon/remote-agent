export interface MessageContext {
  quotedText?: string | null;
  parentBody?: string | null;
  parentAuthor?: string | null;
}

export interface Message {
  cubeIssueIdentifier: string;
  authorName: string | null;
  body: string;
  context?: MessageContext;
}
