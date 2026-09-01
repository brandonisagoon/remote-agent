import type { ServerConfig } from "../../../../../config.ts";
import {
  buildZedDeepLink,
  findMachine,
  getDefaultMachineId,
  getMachine,
} from "../../../../../machines/index.ts";
import {
  AgentIssueLabel,
  type AgentIssue,
  type AgentIssueSyncMetadata,
  type SessionRuntime,
} from "../../../../../../types/sessions/index.ts";

const RUNTIME_START = "<!-- remote-agent-session:v1 -->";
const RUNTIME_END = "<!-- /remote-agent-session:v1 -->";
const SYNC_PREFIX = "<!-- remote-agent-sync:v1 ";
const SYNC_SUFFIX = " -->";

interface StoredAgentIssueSyncMetadata {
  eventId: string;
  generation: number;
  occurredAt: string;
  sourceKey: string | null;
  sourceIdentifier?: string;
}

export function parseAgentIssueRuntime(
  description: string | null,
): SessionRuntime | null {
  if (!description) return null;
  const rows = runtimeRows(description);
  if (!rows.length) return null;
  const values = new Map<string, string>();
  for (const row of rows) {
    const match = row.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/);
    const field = match?.[1]?.trim();
    const value = match?.[2]?.trim();
    if (
      !field ||
      value === undefined ||
      field === "Runtime field" ||
      /^-+$/.test(field)
    ) {
      continue;
    }
    values.set(field, inlineCodeValue(value).replace(/\\\|/g, "|"));
  }

  const harnessSessionId = values.get("Harness session ID");
  const worktreePath = values.get("Worktree");
  const storedLifecycle = emptyToNull(values.get("Lifecycle"));
  const lifecycle =
    storedLifecycle === "one-shot" || storedLifecycle === "persistent"
      ? storedLifecycle
      : null;
  const runtimeSessionId = emptyToNull(values.get("Runtime session ID"));
  if (!harnessSessionId || !worktreePath) return null;

  const labels = labelsFromDescription(description);
  const harness = labels.has(AgentIssueLabel.Harness.Claude)
    ? "claude"
    : "codex";
  const machine =
    findMachine({ trackerLabels: labels })?.id ?? getDefaultMachineId();
  const role = labels.has(AgentIssueLabel.Role.Delegate)
    ? "delegate"
    : labels.has(AgentIssueLabel.Role.Viewer)
      ? "viewer"
      : labels.has(AgentIssueLabel.Role.Unassigned)
        ? "unassigned"
        : "primary";

  return {
    harnessSessionId,
    parentSessionId: null,
    worktreePath,
    branchName: null,
    harness,
    machine,
    role,
    lifecycle,
    runtimeSessionId,
  };
}

function runtimeRows(description: string): string[] {
  const lines = description.split("\n");
  const legacyStart = lines.findIndex((line) => line.trim() === RUNTIME_START);
  const legacyEnd = lines.findIndex((line) => line.trim() === RUNTIME_END);
  const tableStart = lines.findIndex((line) =>
    /^\|\s*Runtime field\s*\|\s*Value\s*\|$/.test(line.trim()),
  );
  if (tableStart < 0) return [];
  const end =
    legacyStart >= 0 && legacyEnd > legacyStart
      ? legacyEnd
      : lines.findIndex(
          (line, index) => index > tableStart && !line.trim().startsWith("|"),
        );
  return lines
    .slice(tableStart, end < 0 ? lines.length : end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
}

function runtimeValues(description: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const row of runtimeRows(description)) {
    const match = row.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/);
    const field = match?.[1]?.trim();
    const value = match?.[2]?.trim();
    if (
      !field ||
      value === undefined ||
      field === "Runtime field" ||
      /^-+$/.test(field)
    )
      continue;
    values.set(field, inlineCodeValue(value).replace(/\\\|/g, "|"));
  }
  return values;
}

function labelsFromDescription(_description: string): Set<string> {
  // Kept as a seam for old sample descriptions. Authoritative labels are
  // applied by agentIssueRuntimeWithLabels below when an issue is fetched.
  return new Set();
}

export function parseAgentIssueSyncMetadata(
  description: string | null,
): AgentIssueSyncMetadata | null {
  if (!description) return null;
  const line = description
    .split("\n")
    .find(
      (entry) => entry.startsWith(SYNC_PREFIX) && entry.endsWith(SYNC_SUFFIX),
    );
  if (!line) return null;
  try {
    const value = JSON.parse(
      line.slice(SYNC_PREFIX.length, -SYNC_SUFFIX.length),
    ) as Partial<StoredAgentIssueSyncMetadata & AgentIssueSyncMetadata>;
    if (
      typeof value.eventId !== "string" ||
      !Number.isSafeInteger(value.generation) ||
      typeof value.occurredAt !== "string"
    ) {
      return null;
    }
    let sourceIssueIdentifier: string | null = null;
    if (typeof value.sourceKey === "string") {
      sourceIssueIdentifier = Buffer.from(value.sourceKey, "base64url").toString(
        "utf8",
      );
    } else if (typeof value.sourceIdentifier === "string") {
      sourceIssueIdentifier = value.sourceIdentifier;
    }
    return {
      eventId: value.eventId,
      generation: value.generation!,
      occurredAt: value.occurredAt,
      sourceIssueIdentifier,
    };
  } catch {
    return null;
  }
}

export function parseAgentIssueSourceIdentifier(
  description: string | null,
): string | null {
  if (!description) return null;
  return (
    emptyToNull(runtimeValues(description).get("Source issue")) ??
    parseAgentIssueSyncMetadata(description)?.sourceIssueIdentifier ??
    null
  );
}

function emptyToNull(value: string | undefined): string | null {
  if (!value || value === "—") return null;
  return value;
}

function inlineCodeValue(value: string): string {
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1).replace(/\\`/g, "`")
    : value;
}

function markdownCell(value: string | null | undefined): string {
  if (!value) return "—";
  const escaped = value
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
  return `\`${escaped}\``;
}

export function buildAgentIssueDescription(
  runtime: SessionRuntime,
  sync: AgentIssueSyncMetadata,
  config: ServerConfig,
): string {
  const machine = getMachine({ id: runtime.machine });
  const zed = buildZedDeepLink(
    machine,
    config.zedRemoteHost,
    runtime.worktreePath,
  );
  return `| Runtime field | Value |
| --- | --- |
| Harness session ID | ${markdownCell(runtime.harnessSessionId)} |
| Worktree | ${markdownCell(runtime.worktreePath)} |
| Lifecycle | ${markdownCell(runtime.lifecycle)} |
| Runtime session ID | ${markdownCell(runtime.runtimeSessionId)} |
| Execution target | ${markdownCell(machine.label)} |
| Source issue | ${markdownCell(sync.sourceIssueIdentifier)} |

+++ Open Session
### Zed
[Open Worktree in Zed](${zed})

### Agent runtime
${runtime.runtimeSessionId ? `acpx session \`${runtime.runtimeSessionId}\`` : "runtime session unavailable"}
+++`;
}

export function agentIssueRuntimeWithLabels(
  issue: AgentIssue,
  parsed: SessionRuntime,
): SessionRuntime {
  const labels = new Set(issue.labels.nodes.map((label) => label.name));
  return {
    ...parsed,
    harness: labels.has(AgentIssueLabel.Harness.Claude) ? "claude" : "codex",
    machine:
      findMachine({ trackerLabels: labels })?.id ?? getDefaultMachineId(),
    role: labels.has(AgentIssueLabel.Role.Delegate)
      ? "delegate"
      : labels.has(AgentIssueLabel.Role.Viewer)
        ? "viewer"
        : labels.has(AgentIssueLabel.Role.Unassigned)
          ? "unassigned"
          : "primary",
  };
}

export function agentIssueDescriptionWithSync(
  description: string | null,
  sync: AgentIssueSyncMetadata,
): string | null {
  if (!description) return null;
  const sourceIdentifier =
    sync.sourceIssueIdentifier ?? parseAgentIssueSourceIdentifier(description);
  const lines = description
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== RUNTIME_START &&
        line.trim() !== RUNTIME_END &&
        !(line.startsWith(SYNC_PREFIX) && line.endsWith(SYNC_SUFFIX)),
    );
  const sourceRow = `| Source issue | ${markdownCell(sourceIdentifier)} |`;
  const sourceIndex = lines.findIndex((line) =>
    /^\|\s*Source issue\s*\|/.test(line.trim()),
  );
  if (sourceIndex >= 0) lines[sourceIndex] = sourceRow;
  else {
    const tableEnd = lines.findIndex(
      (line, index) =>
        index > 0 &&
        lines[index - 1]?.trim().startsWith("|") &&
        !line.trim().startsWith("|"),
    );
    lines.splice(tableEnd < 0 ? lines.length : tableEnd, 0, sourceRow);
  }
  return lines.join("\n");
}
