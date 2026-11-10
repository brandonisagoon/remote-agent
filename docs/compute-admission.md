# Owned compute admission (implementation checkpoint)

Before the first compute claim, a development request may follow the actual
product worktree HEAD without replacing its environment or queue position.
The server verifies the original ownership and a complete never-claimed history,
with no resource, configuration, observation or traffic. It rechecks this proof
inside the update transaction, withdraws old unclaimed offers, and journals the
revision change. Prior claims (including uncertain or stopped ones) still need
the existing saved-resource observation path. No revision update grants capacity
or starts providers; ordinary delivery and claim checks remain mandatory.

DRA182 adds a disabled-by-default host application-compute budget, separate from provider turn capacity. Existing unknown or stale compute is counted conservatively. A queued message reserves no slot; the durable confirmed executing-turn event starts an exact 60-second claim period. A start command claims atomically, repeats the same allocation on retry, and keeps uncertain started capacity until independent stopped observation. Explicit owner resume queues its saved runtime before any effect, then completes the same intent after a real claim. Raw maintenance unpause remains separate.

The current configured immutable runtime observes exact task/environment/resource/proxy identity, request and stream lifetimes, and live service activity. Saved idle files alone grant no authority. Decisions uses bounded sanitized evidence and the fixed gpt-6-luna API only as advice; fresh deterministic ownership, traffic, useful-work, review, pause and operation guards must still pass. Scoped runtime-suspended intent reuses the existing development stop path and does not change ownerPaused or release saved data.

Measured development observations carry a separate current `sourceRevision`.
Environment, route and allocation revision remain their original launch
provenance. The configured observer independently checks HEAD before/after
collection and resets the quiet interval once when it changes, preserving active
requests and log continuity. The source SHA enters the decision/effect snapshot;
a late source change invalidates suspension. Review does not accept this mutable
development field. Existing physical-only saved mode stays incomplete.

Owner enrollment can instrument the exact recorded stock Studio development
group through the existing bearer route. It requires a fresh stopped observation
and a CAS of original resource, task, configuration, offers and allocation history.
Active/uncertain allocations refuse; old unclaimed offers are withdrawn through
normal semantics. It neither registers replacement resources nor allocates a
slot. Paused owner enrollment remains stopped; ordinary start guards still refuse
owner pause. The Drafted producer owns exact route preparation and bounded
installation before a subsequent ordinary primary claim.

The actual legacy Docker/Unix pair passed 2 tests / 43 assertions at client
`7671b10` and server `ab559b5` (test committed separately as `3c2ab98`). It covers
missing measurement retaining the same allocation, extra app-owned resolver-address
listener refusal, busy-to-quiet progress despite heartbeats, complete workspace-first
suspension, capacity release, and same-container/data resume. Docker identities,
processes, relay, NGINX and activity sockets are actual. The fixture uses isolated
network-name/host-port translations, synthetic measured app callbacks, a seeded
confirmed delivery event and an injected Decisions answer. Actual Greenfield
framework and queue hooks have separate tests; this is not pilot acceptance.

DRA-241: after an ordinary owner pause or task closure, the collector can still observe
physical capacity through the already-installed configured runtime. It cannot
install tooling, recreate source, start compute or reopen a task. A distinct
reclamation result binds the original environment/allocation, exact Docker members
or saved native stop proof, current resource and historical task ownership. The
full recursive original session family, same-directory writers and relation graph
must remain settled through the final transaction. Unknown starts, changed members,
missing native proofs and observation errors retain capacity. Only fresh stopped
or absent evidence releases the slot; the result cannot authorize a claim or an
inactivity decision. Original task/resource metadata and owner pauses are unchanged.

During a replacement physical read, the last completed observation remains
available under its original freshness bound. Completed failures, running or
unknown findings invalidate only that unchanged observation generation. A blocked
claim may join an existing reclamation read outside SQL for up to ten seconds;
its final transaction still rechecks capacity, ownership and freshness. Running
or unknown environments remain counted even when their registry row is Released.

Accepted cleanup can settle a released app's exact allocation while its original
primary finishes unrelated cleanup. It needs fresh physical absence, an unchanged
accepted cleanup operation and restart fence, a matching executing primary turn,
and settled other writers. Start and renewal guards enforce the same cleanup
fence. This neither alters the finalizer nor waives completion verification.

Final affected reclamation checks passed 133 tests / 495 assertions on the server
and 63 / 195 on Drafted, with both typechecks. Independent review and final broad
checks remain before the root-owned deployment and disposable rollout acceptance.
No live host configuration or original task was changed by these source tests.

DRA-242 adds separate initial accounting for original development/review groups
that have counted resources but no compute environment. `ComputeBaseline` is one
bounded row per machine/task/purpose, not an environment, offer, enrollment or
resource disposition. A refresh preserves completed credit during its replacement
read under the original freshness bound; a completed refusal revokes that
unchanged generation. The installed immutable `compute baseline-observe` contract reads
the complete original member set; every member must be freshly stopped or absent.
Unsupported, running, changed or unreadable members keep the group reserved.
Previously recorded members remain in that set after registry release.

The final token CAS binds the resource set, original task/primary/source links,
historical recursive family, same-directory writers, pending work, relevant
allocations and global physical ownership claims. Admission recomputes those
facts inside its existing transaction. A slower old refresh cannot overwrite a
newer invalidation. Ordinary offer selection, confirmed delivery and first claim
refresh outside SQL through the same read-only observer; overlapping host callers
share that refresh. Unrelated offers do not invalidate an original group's proof.
The refresh function can also run while policy is disabled, without offering or
enabling anything. Missing observer support leaves all original reservations.

Real disposable SQLite tests cover whole-group accounting with no original
enrollment, preserved closed/paused task and resource rows, Released-row failure,
moved/active descendants, overlapping ownership, stale and concurrent reads. An
actual immutable Git adapter subprocess exercises offer, delivery and first-claim
refresh, including a restart or changed capability between these boundaries. Its
physical answers are controlled fixture inputs; actual client physical observers
have separate contract tests. Production activation and live acceptance remain
root-owned and are not established by this source checkpoint.

## Bounded reconsideration after uncertainty

The host preserves each exact `compute-idle-decision` receipt. A stable evidence
snapshot deliberately ignores heartbeats; it is not a permanent veto after one
uncertain answer. The idle scheduler appends `compute-idle-attempt` records using
the existing metadata journal. Each inactivity episode permits at most three
automatic considerations: the initial attempt, a reconsideration after at least
five minutes, and another after at least fifteen more minutes. Cooldowns begin
at the completed attempt, not a wall-clock bucket. Downtime never dispatches a
burst of missed attempts. A historical idle decision counts as the first
attempt without rewriting its bytes.

A new meaningful request or instruction, or a genuinely new owned application /
allocation lifetime, can open another episode. Snapshot/coverage generation
changes, arbitrary caller keys and heartbeats cannot replenish its budget. All
episodes retain a minimum five-minute environment-wide spacing between attempts.
An explicit leave-running or closure recommendation stays advisory. Missing
credentials and refusals become attention, rather than a repeated paid loop.

An attempt has a committed database claim before any model call. Concurrent
collectors share that durable reservation, not a process-local lock. Its claim
expires after two minutes; an interrupted/unknown dispatch consumes its attempt
and is never resent under the same key. A later consideration applies backoff.
Late results remain recorded but cannot replace a newer attempt or authorize a
stop after losing their claim. Exhaustion is recorded once and requires useful
new activity or a new owned lifetime before another episode.

Each eligible consideration collects fresh physical ownership, coverage, live
activity and sanitized conversation. Pauses, protected reviews, useful operations,
queued work and pending explicit development controls prevent the claim itself.
A suspension recommendation still requires the existing fresh evidence and
per-effect development authority. Capacity is released only after physical stop
reconciliation; the next task uses ordinary offer, delivery and claim semantics.
Code/data, task history and tooling pins are retained. Unknown answers are never
turned into permission to suspend, so exhaustion may leave the queue waiting.

Authenticated `GET /api/tasks/:taskId/compute-policy?capacity=1` includes optional
`idleConsiderations` diagnostics for that task: status, attempt count/limit, next
eligible timestamp and original/latest decision references, choice and safe
failure category. This reads saved state and deterministic evidence without
refreshing providers, collecting conversation, making model requests or writing
rows. Unavailable evidence is reported conservatively. There is no new control,
configuration setting, model rationale requirement or desktop UI.

## Current Decisions input and diagnostic outcomes

DRA301's current input is version 2. It supplies the configured quiet/freshness
thresholds, current request/unknown-request/stream counts, continuous coverage and
collector ages, historical unknown-event age, and actual operation coverage/count.
These are measurements, not candidate flags or instructions to choose suspension.
An old unknown timestamp does not itself mean activity is currently unknown.
Current unknown requests, recent unknown events, incomplete coverage and active
work still fail the independent deterministic checks.

Task/thread context includes the actual name, linked issue and phase plus ordered
literal user/assistant excerpts. The last 32 messages are bounded; the latest eight
receive up to 700 characters and older messages up to 240. Long messages preserve
both ends and first/last control lines, including conflicting keep-running/release
statements. Credentials, code and private URLs are removed before compacting.
Message indexes and explicit omission/truncation counts disclose missing context;
the collector never invents an intent narrative or claims a truncated instruction
was released. The model can recommend leave-running when current need cannot be
ruled out.

New requests offer three choices: leave-running, suspend-compute and
eligible-for-authorized-closure. They do not offer insufficient-evidence.
A new successful result has `kind: "recommendation"` and the actual choice and
confidence. Missing/invalid/ineligible inputs, provider errors, timeouts, refusals
and invalid replies produce explicit server `kind: "diagnostic"` results with a
failure category and request status, without a fabricated choice or confidence.
No-request diagnostics have null request digests. Transient delivery diagnostics
remain within the existing finite retry budget; a conservative leave-running
recommendation remains advisory. Stop/closure authority is still independently
validated and never follows merely from receiving a recommendation.

Historical v1/v2 inputs and saved results, including insufficient-evidence, stay
readable without rewriting their bytes. The new request digest binds the clarified
input, while physical/effect snapshots and episode-reset rules remain unchanged.
An exhausted episode gets no extra call because the input contract changed. The
original P's three decisions/attention therefore remain exhausted; an explicit
owner stop cannot be reported retrospectively as automatic acceptance. A later
actual Q episode uses ordinary ownership, activity, queue and attempt rules.

A timely claim first persists a `validating` reservation on its existing slot.
The original 60-second offer deadline is unchanged. Validation has its own
five-minute deadline; it grants no start or resource-bind authority. Physical
accounting still runs, followed by fresh ownership, recipe, resource and capacity
checks in the transaction that changes the offer to `claimed`. Duplicate requests
share the in-process validation; after restart the persisted token and deadline
allow the same request to resume. Inspection failure retains the slot until
retry, explicit decline, owner invalidation or validation expiry. Late first
requests cannot enter validation. Saved revision/configuration changes refuse a
validation reservation. An explicit-offer CLI command skips queue selection and
uses a default 315-second claim request timeout; explicit caller deadlines remain
authoritative.


## Explicit historical accounting observer adoption

Owner bearer authentication is required even over the trusted local socket.
Adapters cannot call these controls with a tooling-operation header.

1. POST `/api/tasks/:taskId/compute-accounting-observer/inspect` with either
   `{ "kind": "baseline", "purpose": "development" }` (`review` also supported)
   or `{ "kind": "environment", "environmentId": "<original UUID>" }`.
   The response exposes the current binding digest, adoption revision, settled
   state and original executable availability, without private input bytes.
2. If the original executable is unavailable, POST
   `/api/tasks/:taskId/compute-accounting-observer` with that `target`, an owner
   `requestKey`, the inspected `expectedBindingDigest` and `expectedRevision`,
   and an exact registered `releaseId`. Available original readers are preferred.
3. The compatible immutable reader must prove fresh stopped/absent state for
   every original member. The task must remain paused or closed with settled
   writers. Input, ownership and release changes refuse the adoption. A retry of
   the same accepted request returns the original audit receipt.
4. Adoption only appends `compute-accounting-observer-adopted`. It does not grant
   capacity, rewrite producer provenance, activate a tooling release, change task
   pins or reopen work. The ordinary collector independently observes again
   before crediting capacity; normal delivery and claim then apply.

The selected runtime must declare `compute-historical-accounting/v1` and the
corresponding `compute-baseline/v1` or `compute-reclamation/v1` contract. Its
registered release, installed dependency receipt, immutable checkout and adapter
bytes remain verified. Its selection applies only to accounting. Start, recovery
and cleanup keep their existing operation provenance. Original resource states
may become Released without claiming physical absence; immutable member identity
and retained configuration hashes remain binding.

Baseline refresh diagnostics distinguish `ACCOUNTING_OBSERVER_REQUIRED` from
`ACCOUNTING_OBSERVER_CHANGED`. Provider failures still report their observation
failure and retain capacity. Missing retained configuration uses the existing
owner `compute-accounting-input` control; selecting a new reader cannot invent
missing bytes, physical members or original ownership.

## Stop merged app compute while final verification is pending

The normal collector may record an existing scoped `runtime-suspended` intent
when the current owner contract requires a merge and the server has observed
that exact clean source merged. The whole worktree is read again before intent
selection and effect renewal. Final verification may remain stale: this stop
neither refreshes it nor grants Done, deletion or finalizer authority.

Complete fresh traffic and background-operation coverage, no active requests,
settled original descendants (including moved working directories), and no
pending instructions are required. An explicit work-map consumer, browser
resource, retained review environment, newer contract, revocation or owner pause
preserves the app. Physical-only legacy enrollment cannot claim this coverage.

`compute-merged-delivery-stop` records the owner-observed merge reason without
inventing an idle model choice. The original producer's existing stop adapter
and operation binding execute it. A fresh running observation advances its
original claim before stop; only a later fresh stopped observation with settled
writers releases that exact allocation. Lost responses retry the same intent.
Databases, worktree, task/session identity, pins and cleanup journal are retained.


## Retry interrupted closed-family settlement

Before physical reclamation of an unpaused closed task, the existing collector
retries logical settlement of its original family, including moved descendants.
It reserves those exact sessions through the existing provider transport seam
with stopped-only observation. No provider is started or signalled. Original
provider records and actual absence are checked before and during the atomic
closure/inbox/audit write. Uncertain instructions are never completed or cancelled
by this recovery; only unchanged, never-attempted queued work with older provider
watermarks is cancelled. Missing/changed records, live processes, foreign family
links or owner pause retain capacity and a task-activity diagnostic.

The task closure, pins, original relations, provider history, application records
and stores remain untouched. Logical settlement alone grants no capacity: normal
independent app absence collection must still succeed. Concurrent observations
share recovery, and a committed lost response or daemon restart does not repeat
its dispositions. This runs only on the existing compute collector's closed-task
path; the explicit history-reviewed unknown-instruction repair stays separate.
