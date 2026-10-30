import path from "node:path";
import { z } from "zod";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { ProviderDeliveryInput, ExternalDeliveryObservation, Sha } from "./external-delivery-schema.ts";
import { observeExternalRemote } from "./external-delivery-observation.ts";

/** Provider evidence for older delivered scopes whose original PR checkout no
 * longer exists. Required external check runs are not fabricated Actions runs. */
export async function observeDeliveredScope(input: z.infer<typeof ProviderDeliveryInput>, client: CommandClient = bunCommandClient) {
  const delivery = ProviderDeliveryInput.parse(input);
  const read = async (args: string[]) => {
    const result = await client.run("gh", args, { cwd: path.parse(process.cwd()).root });
    if (!result.ok) throw new Error("Delivered scope provider evidence is unavailable");
    return JSON.parse(result.stdout);
  };
  const remote = await observeExternalRemote({ ...delivery, sourcePath: "/", verificationRefs: [] }, false, client);
  const required = z.array(z.object({ name: z.string(), state: z.literal("SUCCESS"), link: z.string() })).min(1).max(100).parse(await read(["pr", "checks", String(delivery.pullRequest), "--repo", delivery.repository, "--required", "--json", "name,state,link"]));
  const names = required.map(check => check.name).sort();
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...delivery.requiredChecks].sort())) throw new Error("Required delivery checks changed or were not explicitly bound");
  const runs = z.object({ total_count: z.number().int().max(100), check_runs: z.array(z.object({ id: z.number().int().positive(), name: z.string(), head_sha: Sha,
    status: z.string(), conclusion: z.string().nullable(), html_url: z.string(), app: z.object({ id: z.number().int().positive() }).nullable() })) }).parse(await read(["api", `repos/${delivery.repository}/commits/${delivery.reviewedHead}/check-runs?per_page=100&filter=latest`]));
  if (runs.total_count !== runs.check_runs.length) throw new Error("Required delivery check inventory is incomplete");
  const statuses = z.object({ sha: Sha, total_count: z.number().int().max(100), statuses: z.array(z.object({ id: z.number().int().positive(), context: z.string(), state: z.string(), target_url: z.string().nullable() })) }).parse(await read(["api", `repos/${delivery.repository}/commits/${delivery.reviewedHead}/status?per_page=100`]));
  if (statuses.sha !== delivery.reviewedHead || statuses.total_count !== statuses.statuses.length) throw new Error("Required delivery statuses do not belong to the complete reviewed head");
  const checks = required.map(required => {
    const matching = runs.check_runs.filter(check => check.name === required.name && check.html_url === required.link);
    const status = statuses.statuses.filter(check => check.context === required.name && check.target_url === required.link);
    if (matching.length + status.length !== 1) throw new Error("Required delivery check cannot be identified uniquely on the exact head");
    if (matching.length) {
      const check = matching[0]!;
      if (check.head_sha !== delivery.reviewedHead || check.status !== "completed" || check.conclusion !== "success") throw new Error("Required delivery check did not succeed on the reviewed head");
      return { name: check.name, head: check.head_sha, kind: "check-run" as const, id: check.id, appId: check.app?.id ?? null, conclusion: "success" as const };
    }
    const check = status[0]!;
    if (check.state !== "success") throw new Error("Required delivery status did not succeed on the reviewed head");
    return { name: check.context, head: delivery.reviewedHead, kind: "status" as const, id: check.id, appId: null, conclusion: "success" as const };
  });
  // Re-read the immutable PR identity/ancestry after all check observations.
  const current = await observeExternalRemote({ ...delivery, sourcePath: "/", verificationRefs: [] }, false, client);
  if (current.mergeCommit !== remote.mergeCommit || current.mergedAt !== remote.mergedAt) throw new Error("Delivered scope changed during verification");
  return ExternalDeliveryObservation.parse({ ...current, reports: [], checks });
}
