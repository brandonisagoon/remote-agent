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
- `usable`: `max(0, slots - unaccounted)`, limited to
  `maxManagedAllocations` when configured.
- `headroom`: `usable - occupied`, including negative values.
- `observedAt`: the observation's timestamp.

The daemon uses its real session activity and the same calculation as normal
selection and claim. Missing, stale, changed or incomplete proof retains its
reservation. The capacity calculation reads one database transaction; it does not refresh
proof, reconcile offers, create slots, queue work or call an observer/provider.
The capacity object returns aggregate counts without credentials or resource identities.
The optional task-scoped `idleConsiderations` array reads saved attempt state and
deterministic evidence separately. It exposes retry/attention status, counts,
next eligible time and decision references; it never refreshes physical evidence,
reads conversation, calls Decisions or writes a claim. It contains no resource
paths or conversation text. These diagnostics are a point-in-time observation,
not an atomic reservation with the capacity snapshot.

Disabled admission returns `{ "enabled": false, "capacity": null }`. Missing
daemon execution observation, a missing/foreign-host task, or an unavailable
calculation returns 409 rather than guessed capacity. Normal API authentication
and the existing private control-socket boundary apply.

This is a point-in-time observation, not a reservation or permission to start.
Normal delivery and claim still recheck capacity and ownership. A later policy
change or task lifecycle event can invalidate the observed headroom.

`machine.compute.maxManagedAllocations` is an optional independent limit on
managed application allocations, including offered, running and unknown
reservations at every slot ordinal. Leaving it unset preserves the total-budget
behavior. Zero blocks new reservations; it does not stop or release existing
allocations. The desktop machine's Application compute settings accept a blank
value to remove the limit. Saving either limit requires a server restart. This
setting does not limit concurrent agent turns.

For an explicit opt-in, set `machine.compute.maxManagedAllocations` to `1`
alongside the existing total `slots` budget. The example and initialized
configuration leave this optional limit unset.

With the limit configured, diagnostics also return `maxManagedAllocations` and
`budgetUsable` (the unclamped `max(0, slots - unaccounted)`). For example, a total
budget of 19 with U varying from 14 to 18 and a managed limit of 1 has `usable: 1`
and permits at most one occupied managed slot. If U reaches 19, usable capacity
is zero. Original unknown usage remains reserved by the same calculation.

Selection, delivery reservation and the first claim recheck the same effective
capacity. Lowering the limit below existing occupancy reports negative headroom
and refuses new reservations or first claims without deleting existing slots.
Retries of an already claimed allocation retain their existing start intent.
