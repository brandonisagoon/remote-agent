# Saved task data during cleanup

`ownership.savedData` is an additive selector on authenticated external-delivery
adoption. Each entry identifies one existing tooling directory/private-directory
record, its exact `manifest.json` path/hash and selected scratch resource IDs.
The existing owner-authorized cleanup flow supplies execution authority. A
saved-data proof restricts that scope; neither its descriptive issue nor old
operation text grants new authority.

The supported historical private-preservation manifest binds task, primary,
original policy pin, archive root and every declared artifact's bytes/hash.
The server independently streams the complete private inventory (8 GiB total,
10,025 files, 250,000 entries), preserving original inode/device/mode and content.
A `manifest-digest.json` sidecar is checked against the historical manifest and
recorded as ancillary observation. Unknown extra files, links, changed/missing
bytes or a mismatched original receipt fail. Nothing is rebuilt or renamed.

`retain-data` keeps the original resource Ready through closure. All source,
Git administration, browser and filesystem capture paths must remain outside it.
The full check runs outside database transactions at preparation/confirmation;
local operation renewals do not repeatedly hash it. The client rechecks retained
bytes before full resource boundaries and actual selected scratch effects.

Scratch selections must include both the exact recorded container and volume.
Their saved `scratch.json`, `restore-verification.json` and Redis byte-roundtrip
report must correspond to the immutable receipts. Existing Docker inspectors
check complete IDs, creation identity, task/purpose/source-purpose/operation
labels, image, network-none isolation, exact volume and no other consumer.
The existing adapter stops/removes only that pair, with container retirement
before volume retirement. Missing acknowledgments resume from independent
absence. There is no generic tooling exemption, original-store removal authority,
new provider mutation API, or new resource record.

Actual read-only DRA8 checks observed all 39 declared artifacts, manifest and
sidecar (41 files, 470,727,319 bytes), plus eight matching scratch records. The
proof does not claim new restore execution or object export. Disposable tests
cover saved-byte changes, replacement/missing/extra files, alias consumers,
partial removal, retry, confirmed retention, cheap renewal, and real paired
server planning/client dispatch/independent confirmation. Original live cleanup
is reserved for the task's authenticated owner after reviewed deployment.
