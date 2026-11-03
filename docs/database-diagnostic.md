# Bounded libSQL diagnostic

Disabled by default. For an explicitly approved diagnostic server restart, set
`REMOTE_AGENT_DB_DIAGNOSTIC_SECONDS` to an integer from `1` through `300` in the
server process environment. The window begins when its first database client is
created. Remove the variable for the next normal restart. It requires no database
or application config change. This patch does not enable or restart anything.

The server's existing stderr receives JSON lines, synchronously before each
libSQL client `execute`/`executeMultiple` invocation and upon completion. Each
start includes an operation ID, operation name, SHA-256 of the exact SQL, and
argument count. Completion includes the same ID, elapsed milliseconds, and
`ok`/`error`. SQL, argument values, error details, and database URLs are never
written. Fingerprints correlate identical SQL; identify a candidate offline by
hashing its SQL. They do not reveal the statement directly.

The process shares a maximum of 2,000 records and 512 KiB across clients, and
stops writing at the window deadline. Completion can therefore be omitted at a
limit; an unmatched start alone does not prove a hang. No timer or background
worker is created. A synchronous native stall leaves its start already written.
Sink failures are ignored; database errors still propagate unchanged.

This wraps the pinned adapter's `createClient` seam. On its local file path,
ordinary queries and BEGIN/COMMIT/ROLLBACK all use that client, after the adapter
mutex has been acquired. A stall before client execution (including the mutex)
does not produce a start. Non-file transaction objects are outside this diagnostic.

Before a release: focused database diagnostic and existing Prisma transaction
tests, TypeScript, the required full suite and desktop build, then normal review
and merge. A supported diagnostic run additionally requires lead approval of the
exact release, temporary supervisor environment, restart, log capture and removal.
No claim of identifying or fixing the current native stall follows from this patch.
