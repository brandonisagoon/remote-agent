export function acpLog(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error ? String(error) : "";
  process.stderr.write(`[remote-agent-acp] ${message}${detail ? `: ${detail}` : ""}\n`);
}
