import { z } from "zod";
import { CleanupObserverError, cleanupObserverReasons } from "./cleanup-observer-diagnostics.ts";
import { FilesystemHandleDiagnostic, FilesystemHandleDiagnosticError, filesystemHandleReason } from "./filesystem-handle-diagnostic.ts";

// These are diagnostic classifications, never authority or automatic repairs.
// Only fixed reviewed text and validated structured fields are retained: even a
// bounded arbitrary Error.message may contain a credential, private URL,
// provider body or agent transcript.
const reasons = {
  LOCAL_COMPLETION_REQUIRED: "A task without a source issue requires its existing owner-authenticated research or local-only completion contract and bound verification; no issue or merge will be invented.",
  LOCAL_COMPLETION_IDENTITY: "Local cleanup requires the unchanged original primary and null source identity, with no linked issue ownership.",
  LOCAL_COMPLETION_UNSAFE: "Local cleanup requires verified clean work and no claimed remote delivery. Preserve changed work and saved data through the existing retention flow before retirement.",
  LOCAL_RETENTION_UNSUPPORTED: "This saved archive format requires linked delivery evidence. Preserve its bytes; local cleanup supports exact copied-evidence and original-source adoption without inventing a source issue or merge.",
  LOCAL_SOURCE_CAPTURE_REQUIRED: "The local task has ignored original material. Preserve it through the existing same-operation original-source archive and capture proof before source retirement; do not discard it or replace the preparation.",
  ...cleanupObserverReasons,
  PR_NOT_FOUND: "No pull request was found for the configured repository and task branch or recorded PR number. Check that recorded delivery correspondence.",
  PR_LOOKUP_FAILED: "The GitHub pull request lookup failed. Check access and the configured repository, task branch or recorded PR number.",
  REPOSITORY_MISMATCH: "The configured delivery repository does not match the worktree Git remote.",
  DELIVERY_MISMATCH: "The observed pull request does not match the accepted repository, branch, commit or base.",
  DELIVERY_NOT_MERGED: "The authorized pull request has not been merged.",
  VERIFICATION_MISSING: "Implementation verification is missing, failed or stale for this completion boundary and worktree.",
  WORKTREE_CHANGED: "The original worktree content or branch changed from the accepted verification. Recheck the exact saved work before retrying.",
  ORIGINAL_ADMINISTRATION_CHANGED: "The original Git administration no longer matches its accepted identity, index or registration. Preserve it and inspect the saved proof.",
  FILESYSTEM_BUSY: "An independently observed process still references the selected source or retained capture. Wait for its existing owner; no absence was established.",
  FILESYSTEM_UNVERIFIED: "The filesystem process or open-handle observation was incomplete or unavailable. No absence was established.",
  ARCHIVE_CHANGED: "Retained archive bytes or identity no longer match the recorded manifest or retention proof. Recheck the exact retained archive.",
  ARCHIVE_OWNERSHIP: "The retained archive does not satisfy its required owned-file, permission or path checks.",
  AUTHORITY_CHANGED: "The original task, turn, pause state or accepted cleanup authority changed. Recheck the current original-task authority.",
  EVIDENCE_COMMAND_FAILED: "A read-only Git evidence command failed. Check the original repository and required Git access.",
  ENOENT: "A required file or directory was not found. Inspect the recorded inputs for this stage; its private path is omitted.",
  EACCES: "Permission to a required input was denied. Inspect its recorded ownership and permissions; its private path is omitted.",
  EPERM: "The operating system refused a required observation. Inspect its ownership and permissions.",
  EIO: "An input/output error prevented verification of a required input.",
  ETIMEDOUT: "A required observation timed out; no completed verification was established.",
  ECONNREFUSED: "A required observation connection was refused; check availability of the recorded service.",
  ECONNRESET: "A required observation connection was interrupted; no completed verification was established.",
  ENOTFOUND: "A required observation host could not be resolved; its private address is omitted.",
  REQUEST_DEADLINE: "The request deadline expired before verification completed.",
  REQUEST_CANCELLED: "The request was disconnected before verification completed.",
  INVALID_OBSERVATION: "A required observation did not match its expected schema. Raw fields and payloads were omitted.",
  UNCLASSIFIED_FAILURE: "Verification failed without a recognized safe diagnostic. Raw exception details were omitted; inspect the recorded inputs for this stage.",
} as const;
type Code = keyof typeof reasons;
export const PreparationFailure = z.object({ code: z.enum(Object.keys(reasons) as [Code, ...Code[]]), reason: z.string().max(320), filesystemHandle: FilesystemHandleDiagnostic.optional() }).strict()
  .refine(value => !value.filesystemHandle || value.code === "FILESYSTEM_UNVERIFIED", "Filesystem handle detail requires its unverified diagnostic");
export type PreparationFailure = z.infer<typeof PreparationFailure>;
const known = (code: Code): PreparationFailure => ({ code, reason: reasons[code] });

/** For producers which can distinguish a failure without exposing command output. */
export class PreparationDiagnosticError extends Error {
  constructor(readonly diagnosticCode: Code) { super(reasons[diagnosticCode]); }
}

const messages = new Map<string, Code>([
  ["Completion repository does not match the configured git remote", "REPOSITORY_MISMATCH"],
  ["Owner Merge approval requires an identifiable GitHub origin", "REPOSITORY_MISMATCH"],
  ["Owner Merge approval could not identify this task's exact pull request", "DELIVERY_MISMATCH"],
  ["Pull request identity could not be verified", "DELIVERY_MISMATCH"],
  ["Discovered PR does not match the owner's authorized task repository, branch, base and current commit", "DELIVERY_MISMATCH"],
  ["The authorized non-draft pull request does not match this task's current commit and base", "DELIVERY_MISMATCH"],
  ["The authorized pull request has not been merged", "DELIVERY_NOT_MERGED"],
  ["Implementation verification is missing, failed or stale for this completion boundary and worktree", "VERIFICATION_MISSING"],
  ...[
    "Worktree changed since finalization preparation; inspect before using a new requestKey", "Worktree changed during finalization preparation",
    "Worktree changed during completion verification", "Worktree branch changed; completion evidence belongs to another branch",
    "Completion snapshot changed during hashing", "Cleanup prepared worktree changed",
    "Original staged, unstaged or untracked state changed since adoption", "Original retained branch or repository changed",
  ].map(message => [message, "WORKTREE_CHANGED"] as [string, Code]),
  ...[
    "Archive directory changed during observation", "Archive file changed during observation", "Archive root changed during observation",
    "Archive input changed", "Archive input changed during observation", "Archive manifest digest changed", "Archive member does not match its manifest",
    "Cleanup retained archive proof changed",
    "Retained archive changed since adoption",
  ].map(message => [message, "ARCHIVE_CHANGED"] as [string, Code]),
  ...[
    "Retained archive root is not an exact directory", "Retained archive must be private and task-owned", "Archive member has an unsafe path",
    "Archive member escapes its root", "Archive input must be a bounded owned regular file", "Manifest must be inside its registered archive",
  ].map(message => [message, "ARCHIVE_OWNERSHIP"] as [string, Code]),
  ...[
    "Preparation original task ownership changed, paused or closed", "Preparation original authority or turn changed",
    "Preparation original authority or turn changed during verification", "Completion authority or task identity changed during verification",
    "Finalization source authority changed during observation", "Cleanup retirement authority was explicitly revoked",
    "Cleanup original ownership is changed, paused or closed", "Cleanup original source ownership changed",
    "Cleanup preparation belongs to another original task identity", "Cleanup accepted completion authority was revoked or replaced",
    "Cleanup accepted verification changed", "Cleanup original retirement grant changed", "Cleanup original retirement identity changed",
    "Cleanup authority, retention proof or original task pin changed", "Cleanup authority changed during initial observation",
    "Cleanup resource scope changed", "Cleanup resource identity or terminal state changed", "Cleanup resource identity or retained metadata changed",
  ].map(message => [message, "AUTHORITY_CHANGED"] as [string, Code]),
  ["Completion evidence could not be verified (gh pr)", "PR_LOOKUP_FAILED"],
  ...[
    "Original administration correspondence changed", "Original administration capture scope changed", "Original administration parent or repository changed",
    "Original administration or registration was recreated", "Original administration changed during verification",
    "Original administration changed during snapshot verification", "Original index changed during observation",
    "Original staged, unstaged or untracked snapshot differs from its archive proof",
  ].map(message => [message, "ORIGINAL_ADMINISTRATION_CHANGED"] as [string, Code]),
  ...[
    "A process still references the owned source root", "A process command still references the linked worktree",
    "A process still holds the linked worktree or its retained capture",
  ].map(message => [message, "FILESYSTEM_BUSY"] as [string, Code]),
  ...[
    "Could not independently inspect task processes", "Source root has open files or could not be inspected",
    "Linked worktree process inspection failed", "Linked worktree open-handle inspection failed; absence is unverified",
    "Root handle inventory is invalid or incomplete", "Root handle inventory is incomplete",
  ].map(message => [message, "FILESYSTEM_UNVERIFIED"] as [string, Code]),
]);

// Never publish a stack or arbitrary path. A bounded frame may name only one
// of these local observation modules and its numeric source line.
const observationModules = new Set([
  "original-work.ts", "original-work-administration.ts", "original-work-git.ts", "installed-dependencies.ts", "archive-observation.ts",
  "finalization-resources.ts", "cleanup-open-handles.ts", "cleanup-filesystem.ts", "cleanup-worktrees.ts", "cleanup-files.ts",
  "cleanup-browsers.ts", "cleanup-vault.ts", "cleanup-preview-retained.ts", "cleanup-adapter-resources.ts", "external-finalization.ts", "external-deliveries.ts",
]);
function localFailure(error: Error): PreparationFailure {
  const stack = Object.getOwnPropertyDescriptor(error, "stack")?.value;
  if (typeof stack === "string" && stack.length <= 64 * 1024) for (const frame of stack.split("\n").slice(1, 17)) {
    const match = /^\s+at [^()\r\n]+ \(([^()\r\n]+):([1-9]\d{0,6}):[1-9]\d{0,6}\)$/.exec(frame)
      ?? /^\s+at ([^()\r\n]+):([1-9]\d{0,6}):[1-9]\d{0,6}$/.exec(frame);
    if (!match?.[1]?.startsWith(`${import.meta.dir}/`)) continue;
    const module = match[1].slice(import.meta.dir.length + 1);
    if (observationModules.has(module)) return { code: "UNCLASSIFIED_FAILURE", reason: `Verification failed at ${module}:${match[2]} without a recognized safe diagnostic. Raw exception details were omitted.` };
  }
  return known("UNCLASSIFIED_FAILURE");
}

export function preparationFailure(error: unknown): PreparationFailure {
  if (error instanceof FilesystemHandleDiagnosticError) {
    const handle = FilesystemHandleDiagnostic.safeParse(Object.getOwnPropertyDescriptor(error, "handle")?.value);
    return handle.success ? { code: "FILESYSTEM_UNVERIFIED", reason: filesystemHandleReason(handle.data), filesystemHandle: handle.data } : known("FILESYSTEM_UNVERIFIED");
  }
  if (error instanceof CleanupObserverError) return error.diagnostic;
  if (error instanceof PreparationDiagnosticError) return known(error.diagnosticCode);
  if (!(error instanceof Error)) return known("UNCLASSIFIED_FAILURE");
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  // Do not echo arbitrary provider error codes, names, causes, messages or stacks.
  if (typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EIO", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "REQUEST_DEADLINE", "REQUEST_CANCELLED"].includes(code)) return known(code as Code);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return known("INVALID_OBSERVATION");
  const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
  if (typeof message !== "string" || message.length > 512) return known("UNCLASSIFIED_FAILURE");
  const recognized = messages.get(message);
  if (recognized) return { code: recognized, reason: message };
  if (/^Completion evidence could not be verified \(git (?:rev-parse|symbolic-ref|status|ls-files|hash-object|ls-remote|remote)\)$/.test(message)) return known("EVIDENCE_COMMAND_FAILED");
  return localFailure(error);
}
