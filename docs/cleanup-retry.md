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
actually completed in the original primary. A separate progress fingerprint
excludes capability configuration: a release alone does not reset the delay or
attempt count. The next eligible attempt resolves the current configured adapter.
Native informational reports do not
count as owner input. Routine observation timestamps, progress/error messages and
preparation-attempt diagnostics do not reset the delay. Changed progress allows
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
two-hour cap at the next upkeep pass. The same option supports a deliberate retry
after a reviewed tooling repair; a routine deployment is not such a request.

Repeating a scheduling key returns its original receipt, even after that
instruction finishes. Different keys, with or without `retry: "now"`, reuse an
outstanding marked cleanup instruction; unknown delivery is never replayed.
Unstarted cancellations and capability supersessions do not count as executed
attempts. Historical markers and retry receipts remain byte-for-byte unchanged.
Older retry receipts lack the separate progress fingerprint. Matching their full
hash, including substitution of the recorded prior capability revision, establishes
unchanged progress. Older markers without that revision use the same conservative
fallback; an explicitly conflicting original task or session still refuses.
A later accepted proof, newly registered resource or completed
subscribed owner input can establish a reset. Otherwise an opaque historical
difference conservatively retains its existing bounded delay and attempt count;
it does not create a permanent block. The first eligible attempt records the new
fingerprint. Earlier-resource changes whose old value cannot be reconstructed may
therefore wait for that one bounded interval, or use the existing explicit repair
retry. Restart does not reset recorded attempts or their delay.

`finalizationPending` stays true during the delay. Released clients use that flag
to choose the cleanup-request path; clearing it could send them into unrelated
generic expiry cleanup. The successful response shape is unchanged, and the
deferred error remains compatible with their existing preserved-task error path.

## Verification

The initial real-DB regression reproduced immediate duplicate execution scheduling
before the fix. Disposable database tests cover increasing/capped delays across
reconnect, progress/proof resets, capability changes without reset, unchanged diagnostics, owner input and
informational reports, same-key replay, explicit retry, concurrent requests,
pending/unknown dedup, pause/revocation, and an attempt finishing during resolution.
An opt-in real Unix HTTP pair exercises the released Drafted strict control client.
Existing inbox, transport, capability-supersession and lifecycle guards remain in
the affected suite. These are source checks; live acceptance belongs to the
existing task owner after reviewed deployment.

The original DRA-99 instructions 1832/1834 shared a fingerprint and advanced from
attempt 1 to 2. Instruction 1837 reset to 1 after the configured release changed.
Read-only reconstruction matched both saved hashes exactly and found only the
capability component changed; all 59 resource rows, accepted proofs and owner
inputs were unchanged. Three new database regressions reproduce premature
scheduling on the prior implementation. They now verify retained delays, capped
attempts, legacy receipt compatibility and current-adapter selection at eligibility.
No original task request or provider action is needed to reproduce this behavior.
