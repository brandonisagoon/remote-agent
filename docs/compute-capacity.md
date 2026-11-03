# Compute capacity observation

Authenticated `GET /api/tasks/:taskId/compute-policy?capacity=1` observes the
configured task's host admission budget. The ordinary request without that
query still returns only `{ "enabled": boolean }`.

With admission enabled, `capacity` contains:

- `slots`: configured budget.
- `unaccounted`: U, the production calculation's reserved original groups and
  uncertain unallocated environments, after revalidating existing proof.
- `occupied`: O, allocated slots at every ordinal, including ordinals above a
  reduced budget.
- `usable`: `max(0, slots - unaccounted)`.
- `headroom`: `usable - occupied`, including negative values.
- `observedAt`: the observation's timestamp.

The daemon uses its real session activity and the same calculation as normal
selection and claim. Missing, stale, changed or incomplete proof retains its
reservation. The request reads one database transaction; it does not refresh
proof, reconcile offers, create slots, queue work or call an observer/provider.
It returns aggregate counts only, without credentials or resource identities.

Disabled admission returns `{ "enabled": false, "capacity": null }`. Missing
daemon execution observation, a missing/foreign-host task, or an unavailable
calculation returns 409 rather than guessed capacity. Normal API authentication
and the existing private control-socket boundary apply.

This is a point-in-time observation, not a reservation or permission to start.
Normal delivery and claim still recheck capacity and ownership. A later policy
change or task lifecycle event can invalidate the observed headroom.
