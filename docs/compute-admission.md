# Owned compute admission (implementation checkpoint)

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

Before each fallible physical read, earlier free-capacity evidence is invalidated.
Running or unknown environments remain counted even when their registry row is
Released; an outage cannot reuse an old stopped observation as zero usage.

Final affected reclamation checks passed 133 tests / 495 assertions on the server
and 63 / 195 on Drafted, with both typechecks. Independent review and final broad
checks remain before the root-owned deployment and disposable rollout acceptance.
No live host configuration or original task was changed by these source tests.
