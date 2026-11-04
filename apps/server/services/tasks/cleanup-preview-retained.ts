import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { finalizationDigest, finalizationResourceIdentity, inspectFinalizationQuarantine, assertFinalizationTree, type FinalizationResourceRecord, type FinalizationResourcePlan } from "./finalization-resources.ts";
import { RetainedPreviewInput, PreviewDeletionConfirmation } from "./cleanup-preview-retained-schema.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const same = isDeepStrictEqual;
const identity = (value: { dev: number; ino: number; mode: number }) => ({ dev: value.dev, ino: value.ino, mode: value.mode });

/** Select only the two already inventoried files named by a registered preview.
 * No filesystem discovery, new archive, or alteration of the accepted plan. */
export function retainedPreviewInputs(resources: FinalizationResourceRecord[], plans: FinalizationResourcePlan[]): RetainedPreviewInput[] {
  const result: RetainedPreviewInput[] = [];
  for (const plan of plans) {
    if (plan.disposition !== "retire-tree" || plan.target.retirement === "delete" || plan.treeKind !== "registered-directory" || !["development", "review"].includes(plan.purpose)
      || plan.key !== `${plan.purpose}-env-directory`) continue;
    const root = plan.target.inventory.find(node => node.path === ".");
    const tunnel = resources.filter(resource => resource.kind === "cloudflare-tunnel" && resource.purpose === plan.purpose);
    for (const resource of tunnel) {
      const meta = object(resource.metadata), configPath = meta.configPath;
      if (configPath !== path.join(plan.target.path, "cloudflared.yml") && !(typeof configPath === "string" && new RegExp(`^<${plan.purpose} env>/cloudflared\\.yml(?: \\([^\\r\\n]{1,1024}\\))?$`).test(configPath))) continue;
      const raw = meta.credentialsFile ?? meta.credentialsPath;
      const matched = typeof raw === "string" ? /^(\/[^\r\n]+?|<(?:development|review) env>\/[^/\r\n]+?)(?: \((?:0400|0600)\))?$/.exec(raw)?.[1] : undefined;
      const connectorPath = matched?.startsWith(`<${plan.purpose} env>/`) ? path.join(plan.target.path, matched.slice(`<${plan.purpose} env>/`.length)) : matched;
      if (!connectorPath || path.dirname(connectorPath) !== plan.target.path || !root || root.kind !== "directory") continue;
      const file = (original: string) => {
        const node = plan.target.inventory.find(node => node.path === path.relative(plan.target.path, original));
        if (!node || node.kind !== "file") throw new Error("Retained preview input is missing from its accepted tree inventory");
        return { path: original, ...identity(node), size: node.size, sha256: node.sha256 };
      };
      const value = RetainedPreviewInput.parse({ resourceId: plan.id, identityDigest: plan.identityDigest, planDigest: finalizationDigest(plan.target),
        sourcePath: plan.target.path, quarantine: plan.target.quarantine, root: identity(root), config: file(path.join(plan.target.path, "cloudflared.yml")), connector: file(connectorPath) });
      const previous = result.find(input => input.resourceId === value.resourceId);
      if (previous && !same(previous, value)) throw new Error("Retained preview input is ambiguous");
      if (!previous) result.push(value);
    }
  }
  return result;
}

/** Supply credentials only after independently verifying the accepted capture.
 * The full plan and original observer capability remain unchanged. */
export async function capturedPreviewInputs(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[] }) {
  const selected: RetainedPreviewInput[] = [];
  for (const value of retainedPreviewInputs(input.resources, input.plan)) {
    const plan = input.plan.find(plan => plan.id === value.resourceId);
    const resource = input.resources.find(resource => resource.id === value.resourceId);
    if (!plan || plan.disposition !== "retire-tree" || !resource || finalizationResourceIdentity(resource).identityDigest !== value.identityDigest)
      throw new Error("Retained preview environment identity changed");
    const location = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: plan.id, target: plan.target });
    if (!location.captured) continue;
    await assertFinalizationTree(plan.target, location.physicalPath);
    const checked = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: plan.id, target: plan.target });
    if (!checked.captured || checked.physicalPath !== location.physicalPath) throw new Error("Retained preview capture changed");
    selected.push(value);
  }
  return selected;
}


/** Bind an already verified independent credential to exact source deletion.
 * Only ordinary provider GETs consume it; it is neither a saved source copy nor
 * a substitute for current provider absence. */
export function bindPreviewDeletionConfirmations(plans: FinalizationResourcePlan[]) {
  const scopes = plans.flatMap(plan => {
    const target = plan.disposition === "retire-file" || plan.disposition === "retire-tree" ? plan.target
      : plan.disposition === "retire-browser" && plan.capture.type === "standalone" ? plan.capture.target
      : plan.disposition === "retire-owned" && plan.target.type === "tree" ? plan.target : undefined;
    return target?.retirement === "delete" ? [{ resourceId: plan.id, path: target.path, targetDigest: finalizationDigest(target) }] : [];
  });
  const effectPaths = plans.flatMap(plan => {
    if (plan.disposition === "retire-adapter") return [plan.observer.task.worktreePath];
    if (plan.disposition === "retire-file" || plan.disposition === "retire-tree" || plan.disposition === "retire-worktree" || plan.disposition === "retire-vault") return [plan.target.path];
    if (plan.disposition === "retire-owned" && plan.target.type !== "endpoint") return [plan.target.path];
    if (plan.disposition === "retire-browser" && plan.capture.type === "standalone") return [plan.capture.target.path];
    return [];
  });
  const within = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);
  for (const plan of plans) {
    if (plan.disposition !== "retire-adapter") continue;
    const config = plan.targets.find(target => target.kind === "local-ingress-route");
    const isPreview = plan.adapter === "preview" || plan.targets.some(target => ["cloudflare-dns-record", "cloudflare-tunnel", "cloudflare-ingress-route", "local-ingress-route"].includes(target.kind));
    if (!isPreview || !scopes.length) { delete plan.previewConfirmation; continue; }
    const proof = plan.previewConfirmation;
    if (!proof || !proof.credential || proof.taskId !== plan.observer.task.id || proof.resourceId !== plan.id || proof.resourceIdentityDigest !== plan.identityDigest
      || proof.purpose !== plan.purpose || config?.kind === "local-ingress-route" && (proof.hostname !== config.hostname || proof.tunnelId !== config.scope.tunnelId || proof.sourceDigest !== config.sourceDigest || proof.configFile !== config.scope.configFile)) throw new Error("Preview deletion requires its verified independent confirmation credential");
    const credential = proof.credential;
    if ("file" in credential && effectPaths.some(root => within(root, credential.file))) throw new Error("Independent preview credential overlaps a deleting scope");
    plan.previewConfirmation = PreviewDeletionConfirmation.parse({ ...proof, deletions: scopes });
  }
  return plans;
}

export function assertPreviewDeletionBindings(plans: FinalizationResourcePlan[]) {
  const copies = plans.map(plan => structuredClone(plan));
  bindPreviewDeletionConfirmations(copies);
  for (const plan of plans) if (plan.disposition === "retire-adapter") {
    const current = copies.find(copy => copy.id === plan.id);
    if (!current || current.disposition !== "retire-adapter" || finalizationDigest(current.previewConfirmation ?? null) !== finalizationDigest(plan.previewConfirmation ?? null)) throw new Error("Preview confirmation deletion scope or credential binding changed");
  }
}
