import { z } from "zod";
import type { ServerConfig } from "../../../../lib/config.ts";
import { linearGraphql } from "../../integrations/linear/client.ts";

const State = z.object({ id: z.string(), name: z.string(), type: z.string() });
const Observation = z.object({ viewer: z.object({ id: z.string() }), issue: z.object({ id: z.string(), identifier: z.string(), updatedAt: z.iso.datetime(),
  state: State, team: z.object({ states: z.object({ nodes: z.array(State) }) }) }).nullable() });

/** The viewer query observes the credential's actual actor. Merely configuring
 * agentUserId cannot turn a human credential into a service-owned state write. */
export async function observeCleanupResumeSource(config: ServerConfig, issueId: string) {
  return Observation.parse(await linearGraphql(config.linearApiKey, `query CleanupResumeSource($id: String!) {
    viewer { id }
    issue(id: $id) { id identifier updatedAt state { id name type } team { states { nodes { id name type } } } }
  }`, { id: issueId }));
}
