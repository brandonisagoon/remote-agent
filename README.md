# Remote Agent

Hono control plane that routes Linear collaboration into durable, server-owned
bb threads. bb owns the canonical transcript, ordered events, execution host,
and lifecycle. Linear is the asynchronous/mobile surface, Zed connects through
the ACP adapter in this app, and the bb desktop/browser UI remains an optional
operations surface.

The service runs on the remote-agent host, not Vercel, and has its own isolated
Prisma/SQLite database.

## Run and verify

```bash
bun run dev:remote-agent
cd apps/remote-agent
bun run lint
bun test
bun run acp                    # stdio ACP server; normally started by Zed
```

The HTTP server binds to `127.0.0.1:9000` by default. Linear webhooks terminate
at `/webhooks/linear`; authenticated compatibility and launch endpoints live
under `/api/*`.

## Ownership and persistence

Each Agents-team Linear issue is a durable routing mirror for one bb thread. It
stores the harness identity, worktree, bb thread ID, machine, role, workflow,
lifecycle, state, and source-issue relation. The local `AgentIssueRecord` table
indexes that mirror by harness session and bb thread; `BbEventCursor` and
`lastBbEventSeq` make event projection replay-safe.

If Linear and bb disagree, bb wins. Old v1 issue descriptions still parse, but
an issue without a bb thread ID is intentionally ineligible after the hard
cutover.

This app never uses the product Postgres database:

| Concern    | Product                 | remote-agent                       |
| ---------- | ----------------------- | ---------------------------------- |
| Schema     | `prisma/schema/`        | `apps/remote-agent/prisma/schema/` |
| Provider   | Neon PostgreSQL         | local SQLite                       |
| Connection | `DATABASE_URL`          | `REMOTE_AGENT_DATABASE_URL`        |
| Client     | workspace Prisma client | `src/generated/prisma`             |

Run Prisma commands with `apps/remote-agent` as the current directory.

## Runtime flow

Inbound comments follow this path:

1. Verify the Linear signature, replay window, and delivery ID.
2. Preserve the existing Agents-team semantic selection rules.
3. Re-fetch and validate the exact selected mirror and its bb thread.
4. Submit the comment with bb `queue-if-active` semantics.
5. Keep the existing Linear reactions and threaded reply contract.

The bb event ingestion loop discovers project threads, tails ordered events,
advances a durable cursor only after projection, and repairs Agents issue state.
A bounded startup reconciliation compares mirrored records with bb thread state.
There is no pane inspection or detached-launch watchdog.

`POST /api/launches` is the shared launch boundary for workspace launchers and
product workers. It spawns the thread on the selected bb host and immediately
creates/binds the Agents mirror; the compatibility hook is not on the critical
path for routability.

`scripts/workspace/agents/session-hook.ts` remains only for Cubic metadata bb
does not know: workflow labels, provider hook identity, subagents, and explicit
worktree cleanup. Its runtime payload carries `BB_THREAD_ID`. bb events own
liveness and failure state.

## Zed ACP adapter

The adapter is part of this app at `src/acp/main.ts`. ACP session IDs are bb
thread IDs. It supports new/load, replay, live event tailing, text prompts,
cancel, tool/message/thought projection, and option-based pending questions.
Zed exposes native selectors for harness, model, permission mode, reasoning
effort, and service-tier speed. Harness changes keep the root ACP session stable while bb runs the
selected harness in a hidden execution thread; reconnecting restores both the
transcript and the selected execution options.
The standard `session/list` response reports each root thread's bb environment
path, so Zed groups and filters sessions by their actual worktree rather than
the shared bb project path. `session/load` accepts a known bb thread ID.

Example Zed configuration:

```json
{
  "agent_servers": {
    "bb": {
      "type": "custom",
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/apps/remote-agent/src/acp/main.ts"],
      "env": {
        "REMOTE_AGENT_BB_URL": "http://127.0.0.1:38886",
        "REMOTE_AGENT_BB_PROJECT_ID": "<project-id>",
        "BB_CWD_MAP": "{\"<project-id>\":\"/absolute/path/to/cubic\"}"
      }
    }
  }
}
```

stdout is reserved for ACP JSON-RPC; diagnostics go to stderr.

## Configuration

| Variable                                  | Default                           | Purpose                                |
| ----------------------------------------- | --------------------------------- | -------------------------------------- |
| `LINEAR_WEBHOOK_SECRET`                   | required                          | Linear webhook signature secret        |
| `REMOTE_AGENT_API_KEY`                    | required                          | Bearer token for `/api/*`              |
| `REMOTE_AGENT_PUBLIC_URL`                 | `https://agents.cubicsurveys.dev` | Public origin for signed session links |
| `GITHUB_WEBHOOK_SECRET`                   | required                          | Deploy webhook signature secret        |
| `LINEAR_API_KEY`                          | required                          | Linear GraphQL access                  |
| `LINEAR_AGENT_USER_ID`                    | required                          | Agent identity/assignee                |
| `LINEAR_AGENT_TEAM_KEY`                   | `AGENT`                           | Session mirror team                    |
| `REMOTE_AGENT_BB_URL`                     | `http://127.0.0.1:38886`          | Canonical bb server                    |
| `REMOTE_AGENT_BB_PROJECT_ID`              | required                          | Cubic bb project                       |
| `REMOTE_AGENT_BB_HOST_MACBOOK_AIR`        | required                          | Air execution host ID                  |
| `REMOTE_AGENT_BB_HOST_MACBOOK_PRO`        | —                                 | Pro execution host ID                  |
| `REMOTE_AGENT_BB_RECONCILE_INTERVAL_MS`   | `60000`                           | Bounded bb/mirror repair interval      |
| `REMOTE_AGENT_MACHINE`                    | `macbook-air`                     | This service's machine identity        |
| `REMOTE_AGENT_WORKSPACE_REPO`             | `~/Desktop/cubic`                 | Full checkout for launch provisioning  |
| `REMOTE_AGENT_DATABASE_URL`               | local SQLite                      | Isolated registry database             |
| `REMOTE_AGENT_HOST` / `REMOTE_AGENT_PORT` | `127.0.0.1` / `9000`              | HTTP listener                          |

bb 0.37.0 has no application bearer token. Keep it on loopback/Tailscale; that
network boundary is the access control boundary.

Agent issue descriptions and orchestration comments include a signed **Open
Thread in bb** link. The public remote-agent route validates the signature and
project, then broadcasts bb's native thread-open action to connected desktop
clients. Linear link previews receive a confirmation page and cannot open a
thread. If more than one bb desktop window is connected to the same server, bb
may present the thread in each of them.

## MacBook Air deployment

```bash
bash scripts/workspace/agents/install-bb-server.sh
bash apps/remote-agent/scripts/install.sh
```

`install-bb-server.sh` installs `bb-app@0.37.0` and a launchd user agent. Bind
to a Tailscale address only when the Pro must reach the server. Then enroll the
Air and Pro with `bb-host-daemon join`, create the Cubic project/baseline
environment, and record the project/host IDs in the remote-agent environment.

`install.sh` deploys remote-agent from a sparse clone, applies its SQLite
migrations, and installs the service/deploy launch agents. The legacy pane
reconciliation launch agent is explicitly retired.

## Source layout

```text
src/
  acp/                          Zed ACP executable and bb projection
  routes/launches/              authenticated shared thread launch API
  routes/session-events/        metadata compatibility bridge
  lib/transports/bb/            official bb SDK adapter and errors
  lib/transports/command/       generic subprocess adapter
  lib/services/sessions/
    bb-events/                  replay-safe ingestion and projection
    reconciliation/             bb-to-Linear repair sweep
    registry/                   Agents mirror + SQLite mapping
    selection/                  unchanged semantic router
  lib/workers/                  Linear business workflows
```
