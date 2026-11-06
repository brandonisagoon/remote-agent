import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeContinueInput } from "./compute-worker.ts";
import { canonicalDigest } from "./tooling-releases.ts";

/** Cross-source shape, pinned from the paired adapter's real-CLI regression
 * (Drafted d8affd6 test/tooling-retained-continuation.test.ts): cliInputDigest
 * of `compute continue --task <id>` includes the parser default
 * purpose=development; the stdin digest is SHA-256 hex of the exact bytes. */
test("the retained compute continue fence digest equals the adapter's cliInputDigest for the spawned command", () => {
  const taskId = "cmw-task", environmentId = "11111111-1111-4111-8111-111111111111", reference = { intentRevision: 7, intentDigest: "a".repeat(64) };
  const stdin = JSON.stringify({ ...reference, environmentId });
  const adapter = canonicalDigest({ operation: "compute continue", taskId, positionals: ["compute", "continue"], options: { purpose: "development", task: taskId }, files: {},
    stdin: createHash("sha256").update(stdin).digest("hex") });
  expect(computeContinueInput(taskId, reference, environmentId)).toEqual({ stdin, inputDigest: adapter });
});
