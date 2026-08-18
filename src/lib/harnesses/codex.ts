export function isCodexExecutable(executable: string): boolean {
  return executable === "codex" || executable.startsWith("codex-");
}
