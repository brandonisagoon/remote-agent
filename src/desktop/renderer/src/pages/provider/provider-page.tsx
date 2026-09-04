import type { ServiceFile } from "../../../../../lib/config.ts";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import type { Mutate } from "@renderer/lib/types.ts";

type ProviderId = keyof ServiceFile["providers"];

/** The adapter commands acpx's built-in launch profiles run when no override is set. */
const BUILTIN_ADAPTERS: Record<string, string> = {
  codex: "codex-acp",
  claude: "claude-agent-acp",
};

export function ProviderPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const providerId = id as ProviderId;
  const provider = value.providers[providerId];
  if (!provider) return <PageHeading title="Provider not found" description={id} />;
  return (
    <Accordion type="multiple" defaultValue={["launch"]} className="-mt-4">
      <SettingsSection
        value="launch"
        title="Launch Command"
        description={`How acpx launches ${PROVIDER_LABELS[id] ?? id} for agent sessions.`}
      >
        <SettingsCard>
          <Field
            label="Command Override"
            value={provider.command?.join(" ") ?? ""}
            placeholder={BUILTIN_ADAPTERS[id] ?? id}
            inputClassName="font-mono"
            description={
              <>
                By default, acpx launches the {PROVIDER_LABELS[id] ?? id}'s process with{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  {BUILTIN_ADAPTERS[id] ?? id}
                </code>{" "}
                via{" "}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      stdio
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    ACP adapters exchange structured protocol messages over standard input/output
                    streams, rather than an interactive CLI.
                  </TooltipContent>
                </Tooltip>
                .
              </>
            }
            onChange={(next) =>
              mutate((file) => {
                const parts = next.split(/\s+/).filter(Boolean);
                file.providers[providerId] = parts.length > 0 ? { command: parts } : {};
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}
