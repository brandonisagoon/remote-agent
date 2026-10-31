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

Focused source checkpoint: 59 observation, admission, enrollment and suspension
tests / 241 assertions plus types pass. Independent reviews cleared the classifier,
sanitizer, allocation, suspension and actual-source evidence seams. The complete
real legacy Docker/Unix pair, final scoped PR reviews and broad checks remain;
no live host configuration or original task was changed by these source tests.
