# ADR 0002: acpx runtime ownership

Status: accepted; supersedes ADR 0001

Remote Agent uses acpx as its only agent execution backbone. The previous bb
SDK, event stream, thread link, host locator, and model-catalog dependencies
have been removed.

The application retains a narrow `AgentSessionRuntime` port. Its acpx adapter
owns queueing, cancellation, transcript access, configuration, usage, provider
switching, and lifecycle fan-out. This keeps workers independent of acpx APIs
while avoiding a second session server.

The existing Prisma/SQLite database is extended with `RuntimeSession` and
`RuntimeEventCursor`. `RuntimeSession.id` is the durable product identity;
acpx record IDs and provider session IDs are replaceable mappings. This solves
duplicate registration after Zed/SSH reconnects: reconnecting loads the stable
row and reattaches the runtime rather than creating a new product session.

The long-lived machine daemon is the sole Prisma and acpx owner. It exposes a
local Unix-socket ACP endpoint. Zed launches a stateless stdio bridge that
forwards ACP frames to that endpoint; restarting the bridge or its SSH
transport cannot create another runtime owner or logical session. The adapter
normalizes provider-specific controls into stable ACP IDs and follows ACP
client capability negotiation for boolean options.

Turn lifecycle events are projected directly from the runtime. Streaming
deltas remain in ACP and the transcript. Projection cursors are consumer-scoped
so future sinks can advance independently.
