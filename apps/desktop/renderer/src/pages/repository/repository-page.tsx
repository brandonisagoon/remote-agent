import { useMemo } from "react";

import type { ServiceFile } from "../../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Badge } from "@renderer/components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@renderer/components/ui/table.tsx";

import { useRepositorySessions } from "@renderer/lib/queries/sessions.ts";
import type { RepositoryTab } from "@renderer/router.tsx";
import { BootstrapSection, GitSection } from "./git-section.tsx";
import { SkillsTab } from "./skills-tab.tsx";
import { LabelsSection } from "./labels-section.tsx";
import { WorkflowsSection } from "./workflows-section.tsx";
import type { Mutate } from "@renderer/lib/types.ts";
import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";

export function RepositoryPage({ id, tab, value, mutate }: { id: string; tab: RepositoryTab; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id];
  if (!repository) return <PageHeading title="Repository not found" description={id} />;
  return (
    <div className="grid gap-6">
      {tab === "sessions" && <SessionsTab repositoryId={id} />}
      {tab === "skillsets" && <SkillsTab id={id} value={value} />}
      {tab === "settings" && <RepositorySettings id={id} value={value} mutate={mutate} />}
    </div>
  );
}

function SessionsTab({ repositoryId }: { repositoryId: string }) {
  const { sessions, loading, error, unavailable, localOnly } = useRepositorySessions(repositoryId);
  const counts = useMemo(
    () => ({
      active: sessions.filter((session) => session.status === "active").length,
      total: sessions.length,
    }),
    [sessions],
  );

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Machine</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={`${session.machineId}:${session.id}`}>
              <TableCell className="max-w-[260px]">
                <div className="truncate font-medium">{session.name ?? session.id}</div>
                <div className="text-muted-foreground truncate font-mono text-[10px]">{session.id}</div>
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap" title={session.machineId}>
                {session.machineName}
                {session.unavailable && <div className="text-xs">Last received state</div>}
              </TableCell>
              <TableCell>
                <Badge variant={session.status === "active" ? "default" : "secondary"}>{session.status}</Badge>
                {session.resourceLinks.some(
                  (link) =>
                    link.resourceType === "comment-thread" &&
                    link.relationship === "question" &&
                    !link.endedAt,
                ) && (
                  <div className="text-muted-foreground/70 mt-0.5 text-xs">awaiting reply</div>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{session.role ?? "—"}</TableCell>
              <TableCell>{session.agentCommand}</TableCell>
              <TableCell>
                <div className="flex max-w-[260px] flex-wrap gap-1">
                  {session.labels.map((tag) => (
                    <Badge key={`${tag.key}:${tag.value}`} variant="outline">
                      {tag.key}:{tag.value}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                {new Date(session.updatedAt).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {error ? (
        <div className="flex flex-col items-center gap-3 py-20">
          <F7Icon name="exclamationmark_circle" className="text-muted-foreground/40 size-8" />
          <p className="text-muted-foreground text-sm">Could not read this repository.</p>
          <p className="text-muted-foreground/70 max-w-md text-center text-xs">{String(error)} Use Refresh Sessions to try again.</p>
        </div>
      ) : !loading && !unavailable.length && sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20">
          <F7Icon name="moon_zzz" className="text-muted-foreground/40 size-8" />
          <p className="text-muted-foreground text-sm">No sessions yet.</p>
          <p className="text-muted-foreground/70 max-w-md text-center text-xs">
            Workflows start sessions when Linear issues enter a configured state or get a reaction.
          </p>
        </div>
      ) : null}
      {localOnly && <p className="text-muted-foreground border-t px-4 py-2 text-xs">This checkout has no network Git origin. Only this machine's sessions can be matched.</p>}
      {unavailable.map((machine) => <p key={machine.hostId} role="status" className="text-muted-foreground border-t px-4 py-2 text-xs">{machine.machineName} is unavailable. {machine.data?.sessions.length ? "Showing its last received sessions. " : "Its sessions may be missing. "}Use Refresh Sessions to try again.</p>)}
      {loading && <p role="status" className="text-muted-foreground border-t px-4 py-2 text-xs">Loading sessions from machines…</p>}
      <div className="text-muted-foreground/70 flex items-center border-t px-4 py-1.5 text-xs tabular-nums">
        {counts.active} active · {counts.total} total
      </div>
    </div>
  );
}

function RepositorySettings({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const repo = useConfig().repoConfig(id);
  return (
    <Accordion type="multiple" defaultValue={["config-file", "git", "bootstrap", "workflows", "labels"]} className="-mt-3">
      {repo.error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive -mx-4 mb-4 rounded-lg border p-4 text-sm">
          Invalid .remote-agent.config.json — fix it in an editor: {repo.error}
        </div>
      )}
      {repo.path && (
        <SettingsSection
          value="config-file"
          title="Config File"
          description="Preparation, naming, workflows, and labels come from this config. External tooling is pinned to its committed Git ref when the server starts."
        >
          <SettingsCard>
            <div className="grid gap-2">
              <Label>Repository Config</Label>
              <InputGroup>
                <InputGroupInput readOnly value={repo.path} className="text-muted-foreground font-mono" />
                <InputGroupAddon align="inline-end">
                  <OpenInEditorMenu target={repo.path} compact />
                </InputGroupAddon>
              </InputGroup>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
      <GitSection id={id} value={value} mutate={mutate} repo={repo} />
      <BootstrapSection root={repository.root} repo={repo} />
      <SettingsSection
        value="workflows"
        title="Workflows"
        description="When a Linear event matches a trigger, the selected skillset is composed into the session's worktree and delivered."
      >
        <WorkflowsSection value={value} root={repository.tooling?.root ?? repository.root} repo={repo} />
      </SettingsSection>
      <SettingsSection
        value="labels"
        title="Labels"
        description="Label groups for sessions, exactly like Linear's issue labels: each group is one dimension (a phase, an area), its labels are the states a session can be in. New sessions start with the group's default label; skills instruct sessions to relabel themselves as work progresses, and router-visible groups help the session router match incoming comments to the right session."
      >
        <LabelsSection repo={repo} />
      </SettingsSection>
    </Accordion>
  );
}
