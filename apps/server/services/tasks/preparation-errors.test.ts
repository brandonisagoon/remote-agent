import { expect, test } from "bun:test";
import { z } from "zod";
import { discoverCompletionPullRequest } from "./completion-observation.ts";
import { preparationFailure } from "./preparation-errors.ts";

// Bun's module-scope errors use bare frames, unlike named/anonymous callbacks.
const moduleScopeError = new Error("private module-scope fixture");

test("known guard and OS failures retain only the safe reason and code", () => {
  expect(preparationFailure(new Error("Worktree changed during finalization preparation"))).toMatchObject({ code: "WORKTREE_CHANGED" });
  const error = Object.assign(new Error("ENOENT /Users/private/secret?token=credential"), { code: "ENOENT", path: "/Users/private/secret" });
  expect(preparationFailure(error)).toEqual({ code: "ENOENT", reason: "A required file or directory was not found. Inspect the recorded inputs for this stage; its private path is omitted." });
  expect(preparationFailure(new Error("Archive manifest digest changed"))).toMatchObject({ code: "ARCHIVE_CHANGED" });
});

test("arbitrary payloads, URLs, credentials, codes, causes and transcripts never enter diagnostics", () => {
  const privateText = "https://owner:password@private.invalid/payload?token=secret\nBearer bearer-value\n{\"apiKey\":\"key-value\"}\nagent transcript";
  for (const error of [privateText, { code: "API_SECRET", message: privateText }, Object.assign(new Error(privateText, { cause: privateText }), { code: "API_SECRET", name: privateText }), new Error("Worktree changed during finalization preparation " + privateText), new Error("x".repeat(100_000) + privateText)]) {
    expect(preparationFailure(error)).toEqual({ code: "UNCLASSIFIED_FAILURE", reason: "Verification failed without a recognized safe diagnostic. Raw exception details were omitted; inspect the recorded inputs for this stage." });
  }
  const invalid = z.literal("safe").safeParse(privateText);
  expect(preparationFailure(invalid.error)).toMatchObject({ code: "INVALID_OBSERVATION" });
  expect(JSON.stringify(preparationFailure(invalid.error))).not.toContain("private.invalid");
});

test("unclassified local guards retain only an allowlisted server source location", () => {
  const error = new Error("private credential and provider body");
  error.stack = `Error: private credential and provider body\n    at assertOriginalWork (${import.meta.dir}/original-work.ts:301:47)\n    at privateToken (/private/secret.ts:9:1)`;
  const result = preparationFailure(error);
  expect(result).toEqual({ code: "UNCLASSIFIED_FAILURE", reason: "Verification failed at original-work.ts:301 without a recognized safe diagnostic. Raw exception details were omitted." });
  expect(JSON.stringify(result)).not.toMatch(/credential|provider body|secret|\/private|:47/);
  for (const frame of ["/private/original-work.ts:301:47", `${import.meta.dir}/not-allowed.ts:301:47`, `${import.meta.dir}/original-work.ts:0:47`, `${import.meta.dir}/original-work.ts:10000000:47`, `${import.meta.dir}/original-work.ts:301:47?token=secret`]) {
    for (const location of [`guard (${frame})`, frame]) {
      error.stack = `Error: private\n    at ${location}`;
      expect(preparationFailure(error).reason).not.toContain("original-work.ts:");
    }
  }
});

test("a real Bun module-scope frame is accepted only for the exact allowed local module", () => {
  const frame = moduleScopeError.stack!.split("\n").find(line => line.startsWith(`    at ${import.meta.path}:`))!;
  expect(frame).toMatch(/preparation-errors\.test\.ts:[1-9]\d*:[1-9]\d*$/);
  expect(preparationFailure(moduleScopeError).reason).not.toContain("preparation-errors.test.ts");
  // Reuse Bun's actual frame grammar, changing only the fixture module name.
  const error = new Error("private module-scope fixture");
  error.stack = `Error: private\n${frame.replace(import.meta.path, `${import.meta.dir}/original-work.ts`)}`;
  expect(preparationFailure(error).reason).toMatch(/^Verification failed at original-work\.ts:[1-9]\d* without/);
  expect(preparationFailure(error).reason).not.toContain(import.meta.dir);
});

test.each([
  ["Source root has open files or could not be inspected", "FILESYSTEM_UNVERIFIED"],
  ["A process still holds the linked worktree or its retained capture", "FILESYSTEM_BUSY"],
  ["Original administration correspondence changed", "ORIGINAL_ADMINISTRATION_CHANGED"],
  ["Retained archive changed since adoption", "ARCHIVE_CHANGED"],
  ["Original staged, unstaged or untracked state changed since adoption", "WORKTREE_CHANGED"],
] as const)("original verification guard has a safe fixed classification: %s", (message, code) => {
  expect(preparationFailure(new Error(message)).code).toBe(code);
});

test.each([
  ["no pull requests found for branch private-branch\nsecret provider payload", "PR_NOT_FOUND"],
  ["GraphQL: Could not resolve to a PullRequest with the number of 4. (repository.pullRequest)", "PR_NOT_FOUND"],
  ["HTTP 403 https://private.invalid/?token=secret", "PR_LOOKUP_FAILED"],
] as const)("actual discovery classifies its command failure without retaining output: %s", async (stderr, code) => {
  let calls = 0;
  try {
    await discoverCompletionPullRequest("/private/path", "private-branch", { run: async command => {
      calls++;
      return command === "git" ? { ok: true, exitCode: 0, stdout: "https://github.com/owner/repository", stderr: "" } : { ok: false, exitCode: 1, stdout: "secret body", stderr };
    } });
    throw new Error("lookup should fail");
  } catch (error) {
    const diagnostic = preparationFailure(error);
    expect(diagnostic.code).toBe(code);
    expect(diagnostic.reason).toContain("configured repository");
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private-branch|private.invalid|private\/path/);
  }
  expect(calls).toBe(2);
});
