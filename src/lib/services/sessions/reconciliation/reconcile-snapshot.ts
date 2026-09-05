import type { ServerConfig } from "../../../config.ts";
import { getMachine, getMachines } from "../../../machines/index.ts";
import type {
  AgentRuntimeSession,
  AgentSessionRuntime,
} from "../../../../types/runtime/index.ts";
import {
  getAgentCatalog,
  getAgentStateId,
  agentIssueLabelIdsWithRouting,
  agentIssueRuntimeWithLabels,
  getAgentIssues,
  parseAgentIssueRuntime,
  updateAgentIssue,
} from "../../../integrations/tracker/index.ts";
import {
  AgentIssueLabel,
  AgentIssueState,
  isReconcilableAgentIssueState,
  type Machine,
} from "../../../../types/sessions/index.ts";

export async function reconcileMachineSnapshot(
  config: ServerConfig,
  machine: Machine,
  sessions: AgentRuntimeSession[],
): Promise<{ connected: number; disconnected: number; ended: number }> {
  const [agentIssues, catalog] = await Promise.all([
    getAgentIssues(config, { machine }),
    getAgentCatalog(config),
  ]);

  let connected = 0;
  let disconnected = 0;
  let ended = 0;
  for (const agentIssue of agentIssues) {
    const parsed = parseAgentIssueRuntime(agentIssue.description);
    if (!parsed || !isReconcilableAgentIssueState(agentIssue.state.name)) continue;
    const runtime = agentIssueRuntimeWithLabels(agentIssue, parsed);
    const session = sessions.find(
      (candidate) => candidate.id === runtime.runtimeSessionId,
    );
    const live = Boolean(
      session && session.status !== "closed" && session.status !== "error",
    );
    const next = live
      ? AgentIssueState.Connected
      : runtime.lifecycle === "one-shot"
        ? AgentIssueState.Ended
        : AgentIssueState.Disconnected;
    const registeredMachine = getMachine({ id: runtime.machine });
    const desiredRouting =
      live && registeredMachine.acceptsTrackerInput && runtime.role === "primary";
    const currentRouting = agentIssue.labels.nodes.some(
      (label) =>
        label.name ===
        (desiredRouting
          ? AgentIssueLabel.Routing.AcceptsInput
          : AgentIssueLabel.Routing.RejectsInput),
    );
    if (agentIssue.state.name === next && currentRouting) continue;
    await updateAgentIssue(config, { id: agentIssue.id }, {
      stateId: getAgentStateId(catalog, { name: next }),
      labelIds: agentIssueLabelIdsWithRouting(
        catalog,
        agentIssue,
        desiredRouting,
      ),
    });
    if (next === AgentIssueState.Connected) connected += 1;
    else if (next === AgentIssueState.Ended) ended += 1;
    else disconnected += 1;
  }
  return { connected, disconnected, ended };
}

/** Change-driven repair pass used at service boot/restart. */
export async function reconcileMachineSessions(
  config: ServerConfig,
  runtime: AgentSessionRuntime,
): Promise<{ connected: number; disconnected: number; ended: number }> {
  const sessions = await runtime.listSessions();
  const totals = { connected: 0, disconnected: 0, ended: 0 };
  for (const machine of getMachines()) {
    const result = await reconcileMachineSnapshot(
      config,
      machine.id,
      sessions.filter((session) => session.executionTarget === machine.id),
    );
    totals.connected += result.connected;
    totals.disconnected += result.disconnected;
    totals.ended += result.ended;
  }
  return totals;
}
