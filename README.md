# Remote Agent

Remote Agent turns Linear collaboration into durable coding-agent sessions backed by [bb](https://github.com/get-bb/bb). It receives tracker webhooks, selects or launches a session on a configured execution host, forwards messages with queue-safe semantics, and projects bb events back to Linear.

The service is intentionally standalone: it owns a small Prisma/SQLite routing database, connects to bb through the official `bb-app` SDK, and operates on a host repository through configuration rather than repository-specific scripts.

## Requirements

- macOS for the included launchd installer
- [Bun](https://bun.sh/) 1.3.14 or newer
- a running bb server with a project and at least one enrolled host
- a Linear OAuth application or API key, webhook secret, agent user, and session-mirror team
- a public HTTPS origin for Linear and GitHub webhooks

## Local setup

```bash
git clone https://github.com/brandonisagoon/remote-agent.git
cd remote-agent
bun install
cp remote-agent.config.example.json remote-agent.config.json
```

Edit `remote-agent.config.json`, create a local environment file, and export it before starting:

```bash
set -a
. ./remote-agent.env
set +a
bun run db:migrate
bun run start
```

The server listens on `127.0.0.1:9000` by default. Linear webhooks terminate at `/webhooks/linear`, GitHub deployment webhooks at `/webhooks/github`, and authenticated launch/session endpoints live under `/api/*`.

Run the verification suite with:

```bash
bun run lint
bun test
```

## Service configuration

`REMOTE_AGENT_CONFIG` selects the JSON service configuration; it defaults to `remote-agent.config.json` in the current directory. See [the example configuration](remote-agent.config.example.json) and [the adoption guide](docs/adoption.md).

The file declares:

- `serviceName`, used for install paths and launchd labels;
- one or more arbitrary execution hosts, each mapped to a bb host ID;
- the host repository root and worktree root;
- the bootstrap command used after worktree creation;
- prompt, harness, and optional model settings for describe, orchestrate, and reflect workflows.

Secrets and machine-local settings stay in the environment:

| Variable | Required | Purpose |
| --- | --- | --- |
| `REMOTE_AGENT_PUBLIC_URL` | yes | Public HTTPS origin for signed links and webhooks |
| `REMOTE_AGENT_API_KEY` | yes | Bearer token for `/api/*` |
| `REMOTE_AGENT_BB_PROJECT_ID` | yes | bb project containing the managed repository |
| `LINEAR_WEBHOOK_SECRET` | yes | Linear webhook signature secret |
| `LINEAR_API_KEY` | yes | Linear GraphQL access |
| `LINEAR_AGENT_USER_ID` | yes | Agent identity and assignee |
| `GITHUB_WEBHOOK_SECRET` | yes | Deployment webhook signature secret |
| `LINEAR_AGENT_HANDLE` | no | Mention handle fallback |
| `LINEAR_AGENT_TEAM_KEY` | no | Session-mirror team; defaults to `AGENT` |
| `REMOTE_AGENT_MACHINE` | no | Configured host ID; defaults to the host marked `default` |
| `REMOTE_AGENT_ZED_HOST` | conditional | SSH host used by Zed links when any configured host is remote |
| `REMOTE_AGENT_BB_URL` | no | bb server URL; defaults to `http://127.0.0.1:38886` |
| `REMOTE_AGENT_DATABASE_URL` | no | SQLite URL; defaults under the service install root |
| `REMOTE_AGENT_HOST` / `REMOTE_AGENT_PORT` | no | Listener; defaults to `127.0.0.1:9000` |
| `REMOTE_AGENT_REFLECT_ON_STATE` | no | Reflection trigger; defaults to `Pull Request` |
| `REMOTE_AGENT_ORCHESTRATE_ON_STATE` | no | Orchestration trigger; defaults to `Planning` |
| `REMOTE_AGENT_END_ON_STATE` | no | Session-end trigger; defaults to `End` |
| `REMOTE_AGENT_DESCRIBE_ON_REACTION` | no | Describe reaction; defaults to `pencil2` |

bb currently has no application bearer token. Keep it on loopback or a trusted private network; that network boundary is its access-control boundary.

## Runtime ownership

bb owns the canonical transcript, ordered event stream, execution placement, provider session, pending interactions, and thread lifecycle. Remote Agent owns webhook receipts, routing metadata, projection cursors, workflow policy, and the Linear mirror. If the two disagree about session liveness, bb wins.

Each issue in the configured Linear agent team mirrors one bb thread. The local `AgentIssueRecord` table provides fast lookup by harness session and bb thread, while `BbEventCursor` makes event projection replay-safe. The product/source issue remains separate and is related to the mirror.

The tracker-neutral contract lives in `src/lib/integrations/tracker/`; Linear is the sole implementation under `src/lib/integrations/linear/`. Workers import the tracker facade, not Linear implementation modules. Adding another tracker is intentionally out of scope for the first release.

## Zed ACP adapter

`src/acp/main.ts` exposes bb threads through Agent Client Protocol. ACP session IDs are bb thread IDs; load/replay, live event tailing, prompts, cancellation, pending questions, harness/model selection, permission mode, reasoning effort, and service tier are supported.

Example Zed configuration:

```json
{
  "agent_servers": {
    "bb": {
      "type": "custom",
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/remote-agent/src/acp/main.ts"],
      "env": {
        "REMOTE_AGENT_BB_URL": "http://127.0.0.1:38886",
        "REMOTE_AGENT_BB_PROJECT_ID": "replace-with-project-id",
        "BB_CWD_MAP": "{\"replace-with-project-id\":\"/absolute/path/to/host-repository\"}"
      }
    }
  }
}
```

stdout is reserved for ACP JSON-RPC; diagnostics go to stderr.

## Install on macOS

Prepare a secrets file and configuration outside the repository, then run:

```bash
REMOTE_AGENT_CONFIG=/absolute/path/to/remote-agent.config.json \
REMOTE_AGENT_ENV_FILE=/absolute/path/to/remote-agent.env \
bash scripts/install.sh
```

The installer clones this repository, copies configuration into `~/Library/Application Support/<serviceName>`, applies SQLite migrations, and installs service and deployment launch agents derived from `serviceName`. Set `REMOTE_AGENT_GIT_REMOTE` to install from a fork or another remote.

## Source layout

```text
src/
  acp/                              Zed ACP executable and event projection
  lib/integrations/tracker/         tracker port and worker-facing facade
  lib/integrations/linear/          Linear API, webhooks, and session store
  lib/transports/bb/                official bb SDK adapter
  lib/services/launches/            configured launch/worktree provisioning
  lib/services/sessions/            local lifecycle, projection, and routing
  lib/workflows/                     host-repository prompt resolution
  lib/workers/                       describe, plan, mention, and reflect flows
```

The architectural decision is recorded in [ADR 0001](docs/adr/0001-runtime-session-ownership-and-distribution.md). The full configuration and host-repository contract is in [the adoption guide](docs/adoption.md).
