export function isClaudeCodeExecutable(executable: string): boolean {
  return executable === "claude" || executable.startsWith("claude-");
}
