# Directory evidence after writer stop

An older local preview can remain Allocated when DNS cleanup fails even after
its app process family has stopped. Directory evidence authorization now asks
the configured immutable cleanup observer to independently inspect that exact
recorded native family and loopback endpoint. It does not request DNS cleanup,
mark the preview Released, or treat an old stop observation as current proof.

The existing authenticated evidence adoption, original preparation, cleanup
operation and retained archive proofs are unchanged. Each authorization and
confirmation still verifies the complete saved copy and capture. Before capture,
the client renews this authorization after its last hook. The server also checks
open handles at both original and captured paths and rechecks the exact resource
inventory after observation and inside the confirmation transaction.

The additional compatibility is deliberately limited to local-http records
with an existing independently verifiable legacy-native proof. Running families,
reused PID identities, replacement listeners, changed launcher/PID files,
unavailable process inventory and unknown writer recipes refuse capture. Other
unreleased writer kinds retain their prior refusal; already Released records
retain the existing policy. This introduces no process, provider or data effects.

Disposable tests use a real Next-shaped process, the normal native stop adapter,
the actual client/server socket path and native directory quarantine. They cover
Allocated/DNS failure preservation, active and replaced writer rejection, lost
confirmation retry, original event immutability, changed resource epochs and
saved-copy preservation. The native observer's supported host remains macOS;
Linux continues to refuse unsupported native-manager inspection. No live DRA-80
proof adoption or cleanup was performed by this change.
