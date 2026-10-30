# Existing-operation resource checks

Older environment-folder and Clerk-user adapters reuse the original v1 cleanup
preparation and operation. They do not create a replacement plan or modify old
authority, evidence or archive receipts.

`POST /api/tasks/:taskId/cleanup-authority` accepts optional `resourceKeys`, a
nonempty list of at most 100 distinct existing keys. Only an unconfirmed v1
operation can request this scope. Its existing original task, primary, pin,
owner pause/revocation, retained-proof epoch and automatic-turn checks still run.

When requested, the existing compact response additionally contains `resources`:
an array of `{ id, key, identityDigest }`, sorted by key. The digest is the
existing `finalizationResourceIdentity` digest; it omits mutable observation
annotations and resource state. Requests without selected keys retain the exact
old response shape. A client must compare the complete selected scope and the
original operation/preparation tuple on every renewal; absence of the new field
is not permission to fall back to an older unchecked adapter.

Supported scopes are deliberately narrow:

- The complete same-root `directory` / `private-env-files` receipt group for one
  recorded development or review environment, including Released aliases during
  interrupted acknowledgment recovery. Original source, tooling, retained
  archives/evidence and any registered task worktree remain protected.
- One task-created development `clerk-test-user` with its recorded provider user
  ID. The existing bounded Clerk-sharing query also considers users recorded by
  email/metadata and sessions referencing that user.

The directory check reuses the existing global ancestor/descendant ownership
query for source, quarantine and journal. Recovery names match the client:
`token = finalizationDigest({ task, root, resources })`, with the response's sorted
identity array. The source's parent contains `.drafted-finalization-${token}`
and `.drafted-environment-${token}.json`. New foreign claims on any of these
paths refuse the next renewal. No caller-supplied path expands the scope.

This database-only response does not prove a file capture or provider deletion.
The client preserves a private immutable retry journal, verifies actual source,
parent, inventory or provider lifetime, and checks current scope immediately
before effects. It independently verifies retained capture or provider absence
before using the existing metadata-preserving resource receipt route. Real
consumer/preview dependencies remain the adapters' responsibility. A read-only
scope check never marks a resource Released.

Regression coverage uses actual task/control routes and unchanged raw
preparation/operation events. The optional real-client pairs exercise native
directory capture, a foreign quarantine claim at the effect boundary, linked
receipt response loss, late shared Clerk ownership, and a lost DELETE response
that retries without a second effect. No live task or provider was modified.
