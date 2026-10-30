# Cleanup observer failures

DRA-225 makes failed resource observations diagnosable without changing their authority. The server reports fixed codes for capability verification, invalid or oversized input, the existing 60-second observer deadline, unsuccessful exit, unexpected stderr, output limits, invalid JSON, transport failure, and failure to verify that the owned process group exited. It still verifies committed capability identity, holds the dedicated process-group leader through cancellation, and refuses incomplete output. No stored preparation or resource proof is rewritten.

The pinned Drafted observer may report exactly one JSON line on stderr after a nonzero exit:

```json
{"version":1,"type":"cleanup-observer-failure","stage":"resource","code":"preview-binding-missing","resource":{"id":"original-resource-id","key":"development-tunnel","kind":"cloudflare-tunnel","adapter":"preview"}}
```

The strict version-one schema is mirrored in `cleanup-observer-diagnostics.ts` in both repositories. Stages are `input`, `resource`, `writers`, and `output`. Codes are a reviewed enum, mapped to fixed server explanations. Resource identity is optional and must use bounded safe registry names, a supported kind/adapter pair, and exactly match a selected resource in the actual serialized request. A resource elsewhere in the inventory cannot be named as the failing selection. Stopped-writer failures use the separately validated complete writer selection. Long safe keys are shortened only for display within the existing 320-character preparation reason limit.

The server accepts no arbitrary message, stack, cause, provider body, stdin, command output, credential, or private path from this envelope. Malformed, extra-field, multi-line, unknown-code, oversized, or mismatched failures retain a fixed exit failure instead. Successful exit with stderr is still a failure, even when stderr looks like this envelope. There is no partial-success format and no change to successful observation schemas or downstream physical-proof validation.

Direct adoption returns the fixed failure in its existing error field. The same typed diagnostic passes through the existing preparation journal and asynchronous status route, retaining the failed stage and safe code/reason; unknown exceptions retain their prior redaction. A failed attempt creates no accepted binding, preparation, confirmation, or cleanup operation.

Validation includes real committed subprocess fixtures for timeout and descendant teardown, output bounds, stderr/exit separation, capability drift, process-group observation refusal, and strict request membership. Authenticated adoption and actual preparation-worker/route tests verify unchanged resources and absent authority after failure. The opt-in paired fixture (`DRAFTED_INTEGRATION_ROOT`) runs the actual clean pinned Drafted CLI: two disposable read-only Docker list checks succeed, the third `development-tunnel` receipt fails its exact hostname/tunnel guard, and the safe failure survives the async journal. It never calls a live provider or host Docker.

The original DRA-98 trace established this preview-binding guard failure separately from the earlier generic 409. This diagnostic change does not repair that legacy receipt format or grant permission to retry live cleanup; that compatibility work remains separate.
