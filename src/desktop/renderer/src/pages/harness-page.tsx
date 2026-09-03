import type { ServiceFile } from "../../../../lib/config.ts";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { HARNESS_LABELS } from "@renderer/lib/sidebar-items.ts";
import type { Mutate } from "@renderer/lib/types.ts";

type HarnessId = keyof ServiceFile["machine"]["acpx"]["agents"];

export function HarnessPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const harnessId = id as HarnessId;
  const harness = value.machine.acpx.agents[harnessId];
  if (!harness) return <PageHeading title="Harness not found" description={id} />;
  return (
    <Accordion type="multiple" defaultValue={["general"]} className="-mt-4">
      <SettingsSection
        value="general"
        title="General"
        description={`How acpx launches ${HARNESS_LABELS[id] ?? id} for agent sessions.`}
      >
        <SettingsCard>
          <Field
            label="Command override"
            value={harness.command?.join(" ") ?? ""}
            description="Leave empty to use acpx's built-in adapter. Space-separated executable and arguments."
            onChange={(next) =>
              mutate((file) => {
                const parts = next.split(/\s+/).filter(Boolean);
                file.machine.acpx.agents[harnessId] = parts.length > 0 ? { command: parts } : {};
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}
