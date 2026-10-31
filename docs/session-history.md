# Saved history after closure

A closed task's activity view still reads its primary and owned delegates' saved
conversation. It does not reopen a session, start a provider, recreate a checkout
or modify the saved record. The normal bearer/local-socket and task
worktree/repository/machine/direct-delegate checks remain in place.

For a session with `status: closed` or a recorded `closedAt`, history uses the
configured acpx session file directly. The acpx store's ordinary load method
creates its directory and treats corrupt records as missing, so it is unsuitable
for this read-only path. The reader checks the saved schema, record ID, backend
session ID, original cwd and optional agent session ID. Logical closure does not
require the provider record's historical `closed` flag to be true. No original
cwd filesystem access is needed.

The regular file is opened without following a leaf symlink. The read allocates
at most its initial 64 MiB size and uses fixed-size positional reads; changed,
missing, oversized, corrupt or foreign records return an error. Activity reports
that history is unavailable rather than presenting these failures as an empty
conversation. User and agent text keep the existing projection; tool/media data
is opaque and grants no action authority. New-work paths still reject closed
sessions and tasks. Open-session history behavior is unchanged.

`closed-history.test.ts` exercises the actual runtime and Unix HTTP activity
route with 62 synthetic saved messages per session, absent checkouts, unchanged
records/database state, and denied provider/process calls. It also covers bearer
and owner/delegate isolation, closed new-work refusal, storage absence,
malformed/foreign records, optional legacy identity, symlinks, oversized files and
growth during the held read. No private conversation is a repository fixture.

DRA-234 was observed after original DRA-71 closed: its 62 saved delegate messages
were independently preserved, but history failed before reading them. Source
regressions and record-shape comparison are distinct from post-deployment
acceptance on that original task. The separate session-status presentation issue
is not changed here.
