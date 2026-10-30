# Retry unfinished cleanup

The existing cleanup inbox defers repeated executed attempts when their recorded
inputs have not changed. Delays are 30 minutes, one hour, then at most two hours,
measured from the previous instruction's terminal timestamp. Ordinary upkeep
continues using `POST /api/tasks/:taskId/cleanup-request` with a stable request key
for each scheduling request. A deferred request returns HTTP 409 with
`code: "cleanup_retry_deferred"` and an ISO `retryAt`; it creates no instruction
and performs no tooling resolution or idle-provider transition.

The scheduling snapshot binds original task/pin identity, registered resource
identities and states, accepted preparation/operation/retention records, the
configured immutable cleanup capability, and subscribed owner source work that
actually completed in the original primary. Native informational reports do not
count as owner input. Routine observation timestamps, progress/error messages and
preparation-attempt diagnostics do not reset the delay. A changed snapshot allows
the original primary to try again, using all existing full preparation and effect
guards. The snapshot itself grants no cleanup authority or physical proof.

After a concrete repair that does not change a recorded input (for example an
external credential repair), an existing authorized owner caller can request an
immediate attempt through the same endpoint:

```json
{"requestKey":"retry-after-credential-repair-1","retry":"now"}
```

This scheduling option is not a new approval or authority grant. It bypasses only
the delay; pause, acceptance, exact original identity, inbox ownership and every
effect guard still apply. Regular scheduled upkeep must omit it. If no explicit
retry is requested, unchanged out-of-band repairs are reconsidered within the
two-hour cap at the next upkeep pass.

Repeating a scheduling key returns its original receipt, even after that
instruction finishes. Different keys, with or without `retry: "now"`, reuse an
outstanding marked cleanup instruction; unknown delivery is never replayed.
Unstarted cancellations and capability supersessions do not count as executed
attempts. Historical markers remain byte-for-byte unchanged; the first normal
attempt after this upgrade establishes its snapshot in the existing metadata
journal. Restart does not reset recorded attempts or their delay.

`finalizationPending` stays true during the delay. Released clients use that flag
to choose the cleanup-request path; clearing it could send them into unrelated
generic expiry cleanup. The successful response shape is unchanged, and the
deferred error remains compatible with their existing preserved-task error path.

## Verification

The initial real-DB regression reproduced immediate duplicate execution scheduling
before the fix. Disposable database tests cover increasing/capped delays across
reconnect, progress/proof/capability resets, unchanged diagnostics, owner input and
informational reports, same-key replay, explicit retry, concurrent requests,
pending/unknown dedup, pause/revocation, and an attempt finishing during resolution.
An opt-in real Unix HTTP pair exercises the released Drafted strict control client.
Existing inbox, transport, capability-supersession and lifecycle guards remain in
the affected suite. These are source checks; live acceptance belongs to the
existing task owner after reviewed deployment.
