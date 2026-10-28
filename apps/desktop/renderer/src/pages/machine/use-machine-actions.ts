import { useNavigate } from "@tanstack/react-router";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";
import { randomHex } from "@renderer/lib/random.ts";

/** The tab controls and native File menu act on the machine in the route. */
export function useMachineActions() {
  const { draft, commit } = useConfig();
  const { host } = useHost();
  const navigate = useNavigate();
  const search = { host: host.id };

  const addProvider = (providerId: "codex" | "claude") => {
    // The native menu can select a configured provider. Open it without
    // replacing its command or any pending edits.
    if (!draft.providers[providerId]) {
      void commit((value) => { value.providers[providerId] ??= {}; });
    }
    void navigate({ to: "/machine/providers/$providerId", params: { providerId }, search });
  };

  const addConnection = () => {
    const connectionId = `linear-${randomHex(6)}`;
    // commit joins pending edits rather than silently saving them.
    void commit((value) => {
      value.connections[connectionId] = {
        provider: "linear",
        name: "New Linear Connection",
        apiKey: "replace-me",
        agentUserId: "replace-me",
        machineId: value.machine.id,
        repositories: "*",
        router: { providerId: "codex", timeoutMs: 30_000 },
        editors: [{ name: "Zed", scheme: "zed" }],
        webhook: {
          slug: `wh-${randomHex(6)}`,
          secret: randomHex(16),
          webhookMaxAgeMs: 60_000,
        },
      };
    });
    void navigate({ to: "/machine/connections/$connectionId", params: { connectionId }, search });
  };

  return { addProvider, addConnection };
}
