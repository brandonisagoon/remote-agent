import type { RepoConfigDraft } from "@renderer/lib/config-context.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import { Label } from "@renderer/components/ui/label.tsx";

const states = { queued: "Queued", processing: "Actively processing", replied: "Reply posted", attention: "Needs attention", failed: "Confirmed failure", planUpdate: "Plan update requested", codeChange: "Code change requested" } as const;

export function ConversationReactionsSection({ repo }: { repo: RepoConfigDraft }) {
  return <SettingsSection value="conversation-reactions" title="Comment Reactions" description="Choose reactions for delivery states. Leave a state empty to disable its reaction. Replies stay in their original thread.">
    <SettingsCard><div className="grid gap-4">
      {Object.entries(states).map(([key, label]) => {
        const state = key as keyof typeof states;
        return <div key={state} className="grid gap-2"><Label htmlFor={`reaction-${state}`}>{label}</Label>
          <Input id={`reaction-${state}`} value={repo.config?.conversationReactions?.[state] ?? ""} placeholder="Emoji or shortcode"
            onChange={(event) => repo.mutate((config) => {
              const value = event.target.value.trim();
              config.conversationReactions ??= {};
              if (value) config.conversationReactions[state] = value;
              else delete config.conversationReactions[state];
              if (!Object.keys(config.conversationReactions).length) delete config.conversationReactions;
            })} />
        </div>;
      })}
    </div></SettingsCard>
  </SettingsSection>;
}
