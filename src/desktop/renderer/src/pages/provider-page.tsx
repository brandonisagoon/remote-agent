import type { ServiceFile } from "../../../../lib/config.ts";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import type { Mutate } from "@renderer/lib/types.ts";

type ProviderId = keyof ServiceFile["machine"]["acpx"]["agents"];

export function ProviderPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const providerId = id as ProviderId;
  const provider = value.machine.acpx.agents[providerId];
  if (!provider) return <PageHeading title="Provider not found" description={id} />;
  return (
    <Accordion type="multiple" defaultValue={["general"]} className="-mt-4">
      <SettingsSection
        value="general"
        title="General"
        description={`How acpx launches ${PROVIDER_LABELS[id] ?? id} for agent sessions.`}
      >
        <SettingsCard>
          <Field
            label="Command override"
            value={provider.command?.join(" ") ?? ""}
            description="Leave empty to use acpx's built-in adapter. Space-separated executable and arguments."
            onChange={(next) =>
              mutate((file) => {
                const parts = next.split(/\s+/).filter(Boolean);
                file.machine.acpx.agents[providerId] = parts.length > 0 ? { command: parts } : {};
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}
