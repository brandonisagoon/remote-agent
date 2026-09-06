export const AGENT_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  team { id key }
  assignee { id }
  state { id name type }
  labels { nodes { id name parent { id name } } }
`;
