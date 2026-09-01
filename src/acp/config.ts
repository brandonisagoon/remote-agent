import { readConfig } from "../lib/config.ts";
import type { BbProviderId } from "../types/runtime/index.ts";

export interface AcpConfig {
  bbBaseUrl: string;
  projectIds: string[];
  cwdByProject: Record<string, string>;
  hostId?: string;
  providerId: BbProviderId;
  model?: string;
}

/** ACP uses the same per-repository JSON file as the HTTP service. */
export function readAcpConfig(): AcpConfig {
  const config = readConfig();
  return {
    bbBaseUrl: config.bbBaseUrl,
    projectIds: [config.bbProjectId],
    cwdByProject: { [config.bbProjectId]: config.repository.root },
    ...config.acp,
  };
}
