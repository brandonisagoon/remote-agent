# Manage a remote machine from the desktop

Electron runs on the client. Each machine's supervised server owns
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

The sidebar lists **Machines** and **Repositories** from every configured host,
with a machine badge on each repository. Machine links open that machine's
**Server**, **Providers** and **Connections** tabs; they do not filter the
repository directory or reload the window. The tabs are centered in the page
header, matching repository tabs. Providers and connections open their existing
settings inside their machine tab, with a link back to the list. Old standalone
provider and connection URLs redirect to those details on the same host.
The legacy `activeId` field only supplies the initial destination for an
unqualified link. Navigation never rewrites the profile file.

Every route, query and action carries its owning host ID. Duplicate repository
or provider IDs on different hosts stay distinct. Drafts remain with their host
when you navigate away, and an unsaved marker appears on its machine entry.
Saving or reverting affects that host's drafts; a delayed save or path picker
cannot be redirected by navigation. Local operations carry request-local config
context through async work instead of changing process-wide environment state.

## Sessions and settings

The desktop retains its existing layout: each repository has its Sessions,
Settings and Skillsets tabs. The sessions table reads that repository's
sessions across all configured machines and identifies each row in a Machine
column. There is no separate Tasks page or header machine dropdown.
Each repository link opens the checkout on its badged machine; its Sessions
tab still combines matching repositories across machines. Machine and repository
navigation, keyboard jumps and back/forward history use the same host identity.
Connection settings display their owning machine as a read-only field with a link
to its details; they do not offer a machine selector.
An offline host does not hide reachable hosts or its own last received entries;
the sidebar offers reconnect and labels cached entries as unavailable.

Repository matching uses the product checkout's Git origin, normalizing SSH
and HTTPS URLs and excluding embedded credentials. Different local repository
IDs or display names still match the same origin; unrelated repositories with
the same name do not. A checkout without a network origin stays scoped to its
original machine. The external tooling checkout is not used as product identity.
Each machine loads independently. An unavailable machine is named below the
table, and any previously received rows remain visibly marked as stale. Refresh
Sessions retries all sources. Duplicate profiles for one machine do not duplicate
its sessions; equal session IDs on different machines remain distinct.

Conversation continuation and task supervision remain available through
Linear, Zed/ACP and the owner MCP. Those interfaces use the same durable task
and session identities. The desktop does not add a second supervision UI.

An available public app preview adds **Open in ChatGPT** to its existing session
row. Its deep link prefills the review skill and exact remote task binding, and
uses the repository's credential-free Git origin to select a matching local
workspace in ChatGPT. It never passes the remote worktree as a local path. A
repository without a network origin leaves workspace selection to the user.
The same link includes `browserUrl`, which the installed ChatGPT desktop app
handles by opening its browser panel alongside the prepared chat. The user can
see the preview immediately and still presses Send to run the review skill.

Settings, file browsing, model discovery, status and restart run on the
machine that owns the item you opened. Editor detection and keyboard preferences stay on the
client. The ACP command displayed for a remote machine includes SSH and its
actual runtime path. Installation and update deployment stay in the host's
normal installation workflow; the desktop does not run remote installer
commands. Restart refuses active/provisioning sessions and held browser
control. If the server cannot report its activity, restart fails closed;
inspect it over SSH before recovery.

The machine's Server tab includes a Storage section with **Concurrent agent turns**
(`machine.acpx.maxConcurrentTurns`). A positive integer limits provider turns
on that host; blank preserves the default unlimited behavior. Restart the
server to apply a change. Waiting instructions retain their durable queued
state until a slot and provider handle are available. The limit does not cap
application containers, detached processes, builds, or GPU usage.

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
ends when the desktop quits; navigating to another machine leaves it intact.

The desktop reconnects on the next read and polls the same session IDs.
Configuration reads load independently across hosts to populate the directory.
Edits and service actions always address their original owner. The existing
sessions table reports read failures; startup failures keep the complete
available directory reachable. It never creates a replacement task, migrates work, grants
browser control or resumes automation as part of reconnecting.

Only the owner's authenticated SSH connection reaches the host's existing
user-only control socket. No server credential is copied to the client and
no public control endpoint is added. Existing Linear actor restrictions and
workflow routing remain authoritative for Linear intake.

Answers and subsequent messages wait for the current turn to finish. If an
agent remains inside an active turn while waiting for an answer, pause that
turn, then resume to deliver the already saved answer. This preserves the
session and receipt; it does not resend the original instruction.
