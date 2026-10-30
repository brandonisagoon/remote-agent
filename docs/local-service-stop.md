# Stopping older task apps

Older task receipts can name an API, web app or PostHog fixture using a task-local
`run.sh`, PID file and Compose environment. They need a compute stop before the
source can pass cleanup's open-process checks. They do not need to adopt a full
external-delivery cleanup plan to stop that compute.

`POST /api/sessions/:sessionId/local-service-stop-authority` is a read-only
counterpart to the browser-stop authority route. It requires the active original
primary, an unpaused/open task, exact source linkage, and a current executing turn
correlated with the latest started lifecycle event. It resolves the configured
immutable cleanup capability while preserving the original task's tooling pin.
It returns the exact endpoint and same-environment resource identities; another
task's PID file, Compose environment, or listener port causes refusal. Identity
and execution are checked again after capability resolution. No approval,
workflow, source-state, resource-state or preparation event is manufactured.

The matching Drafted `resource stop` path rechecks that witness around every
observation write and identity-bound process signal. Existing native receipt
validation freezes launcher/PID-file bytes, executable, arguments, UID, kernel
lifetime and supported descendants. New stop-only observation never queries or
mutates the Compose stores. The selected app family and listener must disappear;
other apps and all saved material remain. The immutable family proof is reused
for interrupted receipt writes and lost stop responses. A changed generation,
launcher, unknown child, shared scope, manager or listener is preserved and
reported. Stop results never claim release or whole-group consumer absence.

Validation uses disposable Bun/Node processes, private proof files and a real
control socket with a temporary database. It covers selective stops, old receipts
without candidate-checkout metadata, independent saved data, pause and executing
turn changes, replaced processes/listeners, and same-proof interrupted retries.
The original DRA-42 services have not been touched; live acceptance remains a
release-owner step. Unknown services and non-macOS native-manager inspection
remain unsupported rather than falling back to raw PID or port signaling.
