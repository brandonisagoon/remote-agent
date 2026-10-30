import { expect, test } from "bun:test";
import { DeliveredRetirementInput, ExternalDeliveryBindingInput } from "./external-delivery-schema.ts";

const head = "a".repeat(40);
const digest = "b".repeat(64);
const delivery = { id: "delivered", repository: "drafted-ai/greenfield", pullRequest: 1,
  branch: "codex/delivered", reviewedHead: head, baseBranch: "staging", expectedMergeCommit: "c".repeat(40) };
const resourceIds = ["source-copies"];
const legacy = { version: 1, mode: "legacy-delivery", requestKey: "exact-paths", expectedBindingRevision: 0,
  expectedIdentityDigest: digest, source: { issueId: "issue", stateId: "done", updatedAt: "2026-10-30T00:00:00.000Z" },
  basis: "Retire the exact recorded task resources", cleanupSnapshot: { head, branch: "codex/original", clean: true, fingerprint: digest },
  deliveries: [{ ...delivery, requiredChecks: ["CI / CI"] }], mergeOrder: ["delivered"], resourceIds };
const external = { version: 1, requestKey: "exact-paths", expectedContractRevision: 1, expectedBindingRevision: 0,
  acceptance: { approvalEventSequence: 1, ownerCommentId: "comment", ownerCommentDigest: digest },
  deliveries: [{ ...delivery, sourcePath: "/private/task/source", verificationRefs: [{ kind: "ci-run", runId: 1, workflowId: 1, head }] }],
  mergeOrder: ["delivered"], resourceIds };

for (const [name, schema, input] of [
  ["legacy delivery", DeliveredRetirementInput, legacy],
  ["external delivery", ExternalDeliveryBindingInput, external],
] as const) {
  test(`${name} preserves all 103 individually selected paths`, () => {
    // The current task shape is 97 standalone files, five explicit roots and a browser root.
    const ownedPaths = [
      ...Array.from({ length: 97 }, (_, i) => `/private/task/evidence/${i}.json`),
      ...Array.from({ length: 5 }, (_, i) => `/private/task/roots/${i}`),
      "/private/task/browser",
    ];
    const parsed = schema.parse({ ...input, ownership: { sourceCopyResourceId: "source-copies", ownedPaths } });
    expect(parsed.ownership.ownedPaths).toEqual(ownedPaths);
    expect(parsed.ownership.ownedPaths).toHaveLength(103);
  });

  test(`${name} retains the bounded 1000-path limit and canonical path validation`, () => {
    const ownedPaths = Array.from({ length: 1000 }, (_, i) => `/private/task/exact/${i}`);
    const request = { ...input, ownership: { sourceCopyResourceId: "source-copies", ownedPaths } };
    expect(schema.parse(request).ownership.ownedPaths).toHaveLength(1000);
    expect(schema.safeParse({ ...request, ownership: { ...request.ownership, ownedPaths: [...ownedPaths, "/private/task/exact/1000"] } }).success).toBe(false);
    expect(schema.safeParse({ ...request, ownership: { ...request.ownership, ownedPaths: ["/private/task/../broader"] } }).success).toBe(false);
  });
}
