/** URL-scheme families with a known SSH remote-editing link shape. */
const SSH_LINK_FORMATS: Record<string, (host: string, path: string) => string> = {
  zed: (host, path) => `zed://ssh/${encodeURIComponent(host)}${encodeURI(path)}`,
  vscode: (host, path) => `vscode://vscode-remote/ssh-remote+${encodeURIComponent(host)}${encodeURI(path)}`,
  cursor: (host, path) => `cursor://vscode-remote/ssh-remote+${encodeURIComponent(host)}${encodeURI(path)}`,
};

export function sshLinkSupported(scheme: string): boolean {
  return scheme in SSH_LINK_FORMATS;
}

export function buildEditorDeepLink(
  connection: "local" | "ssh",
  scheme: string,
  remoteHost: string | null,
  worktreePath: string,
): string {
  if (connection === "local") {
    return `${scheme}://file${encodeURI(worktreePath)}`;
  }
  if (!remoteHost) {
    throw new Error("remoteHost is required for an SSH machine");
  }
  const format = SSH_LINK_FORMATS[scheme];
  if (!format) {
    throw new Error(`editor scheme ${scheme} has no SSH link format`);
  }
  return format(remoteHost, worktreePath);
}
