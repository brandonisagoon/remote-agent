# Manage a remote machine from the desktop

Electron runs on the client. The selected machine's supervised server owns
tasks, sessions, credentials and worktrees. Closing Electron, a preview, or
its SSH connection does not close remote sessions or resume paused work.

## Connect a machine

Install this revision of Remote Agent and its dependencies on the remote
machine. Its server must already be configured and running. Establish the
owner's SSH key and known-host entry normally; the desktop uses batch SSH
and rejects unknown host keys. It does not prompt for or store passwords.

Create `desktop-hosts.json` in the desktop's user-data directory (normally
`~/Library/Application Support/Remote Agent` on macOS). This file contains
connection paths, not remote API keys. For example:

```json
{
  "activeId": "air",
  "hosts": [
    {
      "id": "local",
      "name": "This Mac",
      "kind": "local",
      "configPath": "/Users/owner/Library/Application Support/remote-agent/remote-agent.config.json"
    },
    {
      "id": "air",
      "name": "MacBook Air",
      "kind": "ssh",
      "sshHost": "owner-air",
      "machineId": "macbook-air",
      "executable": "/opt/homebrew/bin/bun",
      "runtimePath": "/Users/owner/Developer/remote-agent",
      "configPath": "/Users/owner/Library/Application Support/remote-agent/remote-agent.config.json"
    }
  ]
}
```

Paths must be absolute paths on the indicated machine. `runtimePath` is a
checkout containing `management/desktop-bridge.ts` and installed dependencies.
`machineId` must equal that remote configuration's machine ID. When managing
a separate macOS pilot service, set `serviceLabel` to its launch-agent label;
restart verifies that its plist points to the exact configured file. A label
is optional for the standard installation. The first version reads profiles
at app startup; adding or changing profiles requires relaunching the desktop.

Choose a configured machine in the existing **Machines** sidebar section. Save or revert settings
before switching. Every request carries the renderer's original machine ID;
after switching, stale requests are refused rather than redirected. The
renderer reloads to discard the previous machine's cached state.

## Sessions and settings

The desktop retains its existing layout: each repository has its Sessions,
Settings and Skillsets tabs. The sessions table reads the selected machine's
existing sessions. There is no separate Tasks page or header machine dropdown.
Choosing another machine opens its existing Machine page and reloads its
configuration; selecting a repository returns to its usual tabs.

Conversation continuation and task supervision remain available through
Linear, Zed/ACP and the owner MCP. Those interfaces use the same durable task
and session identities. The desktop does not add a second supervision UI.

Settings, file browsing, model discovery, status and restart run on the
selected machine. Editor detection and keyboard preferences stay on the
client. The ACP command displayed for a remote machine includes SSH and its
actual runtime path. Installation and update deployment stay in the host's
normal installation workflow; the desktop does not run remote installer
commands. Restart refuses active/provisioning sessions and held browser
control. If the server cannot report its activity, restart fails closed;
inspect it over SSH before recovery.

Remote configuration responses omit raw JSON and replace stored credentials
with markers. Saving restores each marker only at its original field in a
revision-checked document. Entering a new value replaces that credential on
the host. Machine identity cannot be changed through the remote form. Policy
edits for an external tooling repository go to that tooling checkout; they
still require a commit and the normal pin/restart procedure before tasks use
the change.

## Private previews and reconnection

The desktop bridge can resolve a task's recorded loopback HTTP resource and open
an owner-SSH connection bound to client loopback. A local HTTP/WebSocket
forwarder preserves the original Host and Origin, so strict browser gateways
work with temporary client ports. It checks its own Host and Origin before
forwarding. The control API port and arbitrary public URLs are refused. A streamed browser viewer opens the actual
remote profile; a direct web preview uses the client browser's state. Preview
windows have no desktop preload, Node access or desktop IPC API. Forwarding
ends when the desktop quits or changes machine; remote resources remain.

The desktop reconnects on the next read and polls the same session IDs.
The existing sessions table reports read failures; startup failures keep
Machines navigation available. It never creates a replacement task, migrates work, grants
browser control or resumes automation as part of reconnecting.

Only the owner's authenticated SSH connection reaches the host's existing
user-only control socket. No server credential is copied to the client and
no public control endpoint is added. Existing Linear actor restrictions and
workflow routing remain authoritative for Linear intake.

Answers and subsequent messages wait for the current turn to finish. If an
agent remains inside an active turn while waiting for an answer, pause that
turn, then resume to deliver the already saved answer. This preserves the
session and receipt; it does not resend the original instruction.
