import type { BbProviderId } from "../types/runtime/index.ts";

export interface AcpConfig {
  bbBaseUrl: string;
  projectIds: string[];
  cwdByProject: Record<string, string>;
  hostId?: string;
  providerId: BbProviderId;
  model?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readAcpConfig(): AcpConfig {
  const singleProject = process.env.REMOTE_AGENT_BB_PROJECT_ID?.trim();
  const projectIds = (process.env.BB_PROJECT_IDS ?? singleProject ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (projectIds.length === 0) {
    throw new Error("BB_PROJECT_IDS or REMOTE_AGENT_BB_PROJECT_ID is required");
  }

  let cwdByProject: Record<string, string> = {};
  const rawMap = process.env.BB_CWD_MAP?.trim();
  if (rawMap) {
    const parsed = JSON.parse(rawMap) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("BB_CWD_MAP must be a JSON object of project IDs to paths");
    }
    cwdByProject = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  const provider = process.env.BB_ACP_PROVIDER?.trim() ?? "codex";
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error("BB_ACP_PROVIDER must be codex or claude-code");
  }

  return {
    bbBaseUrl: required("REMOTE_AGENT_BB_URL"),
    projectIds,
    cwdByProject,
    hostId: process.env.BB_ACP_HOST_ID?.trim() || undefined,
    providerId: provider,
    model: process.env.BB_ACP_MODEL?.trim() || undefined,
  };
}
