import { randomUUID } from "node:crypto";
import path from "node:path";
import { observeArchive } from "./archive-observation.ts";
import { finalizationDigest, finalizationInventory, finalizationResourceObservation, type ResourceObservation } from "./finalization-resources.ts";
import { prepareInstalledDependencies } from "./installed-dependencies.ts";
import { LegacyOriginalArchiveInput, LegacyOriginalWork } from "./legacy-original-work-schema.ts";
import { prepareOriginalAdministration } from "./original-work-administration.ts";
import { originalWorkGit as git } from "./original-work-git.ts";
import { assertOriginalWorkCapture, verifyOriginalBundleArchive } from "./original-work.ts";

/** Reuses the same bundle restore, whole-source and linked administration
 * engines as v2, without inventing a resource or changing v1 preparation. */
export async function prepareLegacyOriginalWorkFiles(input: { taskId: string; worktree: string; branch: string; approvedHead: string; fingerprint: string; archive: LegacyOriginalArchiveInput }, observation: ResourceObservation = finalizationResourceObservation) {
  const selection = LegacyOriginalArchiveInput.parse(input.archive), root = selection.archiveRoot;
  const { snapshot, archive, restore } = await verifyOriginalBundleArchive({ ...input, root, selection });
  if (!snapshot.clean || snapshot.fingerprint !== input.fingerprint) throw new Error("Legacy original source differs from its exact accepted clean snapshot");
  const ignored = (await git(input.worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  for (const name of ignored) {
    const file = path.join(input.worktree, name);
    if (!selection.ownedPaths.some(owned => file === owned || file.startsWith(`${owned}${path.sep}`))) throw new Error("Ignored original material needs explicit owner-adopted paths");
  }
  const installedDependencies = await prepareInstalledDependencies(input.worktree), captureId = `original-worktree:${input.taskId}`;
  await (installedDependencies.length ? observation.linkedRootIdle ?? observation.rootIdle : observation.rootIdle)(input.worktree);
  const inventory = await finalizationInventory(input.worktree, [input.worktree], new Map(installedDependencies.map(dependency => [dependency.path, captureId])), new Map());
  const directory = path.join(path.dirname(input.worktree), `.drafted-finalization-${randomUUID()}`);
  const capture = { version: 1 as const, captureId, snapshot, restore, ...(installedDependencies.length ? { installedDependencies } : {}),
    target: { type: "tree" as const, path: input.worktree, inventory, sourcePaths: [input.worktree], quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } };
  const proof = LegacyOriginalWork.parse({ ...capture, archive: { root, manifestPath: selection.manifestPath, manifestSha256: selection.manifestSha256, inventory: archive.inventory, inventoryDigest: archive.inventoryDigest }, administration: await prepareOriginalAdministration(input.taskId, capture) });
  await assertLegacyOriginalWorkFiles({ taskId: input.taskId, originalWork: proof, removed: false }, observation);
  return proof;
}

/** Full boundary validation remains valid after both original paths disappear.
 * Captured bytes, both handle boundaries, and real Git absence are observed. */
export async function assertLegacyOriginalWorkFiles(input: { taskId: string; originalWork: LegacyOriginalWork; removed: boolean }, observation: ResourceObservation = finalizationResourceObservation) {
  const proof = LegacyOriginalWork.parse(input.originalWork), expected = proof.archive;
  const archive = await observeArchive(expected.root, expected.manifestPath, expected.manifestSha256);
  if (archive.inventoryDigest !== expected.inventoryDigest || finalizationDigest(expected.inventory) !== archive.inventoryDigest) throw new Error("Legacy original archive changed since adoption");
  await assertOriginalWorkCapture({ ...input, originalWork: proof }, observation);
}
