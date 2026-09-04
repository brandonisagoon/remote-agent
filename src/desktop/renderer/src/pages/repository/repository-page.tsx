import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Badge } from "@renderer/components/ui/badge.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@renderer/components/ui/table.tsx";

import { sessionsQueryOptions } from "@renderer/lib/queries/sessions.ts";
import type { RepositoryTab } from "@renderer/router.tsx";
import { SkillsTab } from "./skills-tab.tsx";
import { LabelsSection } from "./labels-section.tsx";
import { WorkflowsSection } from "./workflows-section.tsx";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

export function RepositoryPage({ id, tab, value, mutate }: { id: string; tab: RepositoryTab; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id];
  if (!repository) return <PageHeading title="Repository not found" description={id} />;
  return (
    <div className="grid gap-6">
      {tab === "sessions" && <SessionsTab repositoryId={id} />}
      {tab === "skillsets" && <SkillsTab id={id} value={value} mutate={mutate} />}
      {tab === "settings" && <RepositorySettings id={id} value={value} mutate={mutate} />}
    </div>
  );
}

function SessionsTab({ repositoryId }: { repositoryId: string }) {
  const query = useQuery(sessionsQueryOptions(repositoryId));
  const sessions = query.data ?? [];
  const loading = query.isFetching;
  const error = query.error ? (query.error instanceof Error ? query.error.message : String(query.error)) : null;
  const counts = useMemo(
    () => ({
      active: sessions.filter((session) => session.status === "active").length,
      total: sessions.length,
    }),
    [sessions],
  );
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {counts.active} active · {counts.total} total
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          <F7Icon name="arrow_2_circlepath" className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      {error ? (
        <div className="rounded-md border p-4 text-sm">
          <span className="text-destructive font-medium">Daemon unavailable:</span>{" "}
          <span className="text-muted-foreground">{error}</span>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Labels</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate font-medium">{session.name ?? session.id}</div>
                    <div className="text-muted-foreground truncate font-mono text-[10px]">{session.id}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={session.status === "active" ? "default" : "secondary"}>{session.status}</Badge>
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
          {!loading && sessions.length === 0 && (
            <div className="text-muted-foreground p-10 text-center text-sm">No sessions for this repository.</div>
          )}
        </div>
      )}
    </div>
  );
}

function RepositorySettings({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  return (
    <Accordion type="multiple" defaultValue={["paths", "workflows", "labels"]} className="-mt-3">
      <SettingsSection
        value="paths"
        title="Paths & bootstrap"
        description="Where sessions check out and how a fresh worktree gets ready."
      >
        <SettingsCard>
          <Field label="Display name" value={repository.name ?? id} onChange={(next) => mutate((file) => { file.repositories[id]!.name = next; })} />
          <Field label="Checkout root" value={repository.root} onChange={(next) => mutate((file) => { file.repositories[id]!.root = next; })} />
          <Field label="Worktree root" value={repository.worktreeRoot} onChange={(next) => mutate((file) => { file.repositories[id]!.worktreeRoot = next; })} />
          <Field label="Bootstrap command" value={repository.bootstrapCommand.join(" ")} onChange={(next) => mutate((file) => { file.repositories[id]!.bootstrapCommand = next.split(/\s+/).filter(Boolean); })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="workflows"
        title="Workflows"
        description="When a Linear event matches a trigger, the selected skillset is composed into the session's worktree and delivered."
      >
        <WorkflowsSection id={id} value={value} mutate={mutate} />
      </SettingsSection>
      <SettingsSection
        value="labels"
        title="Labels"
        description="Label groups for sessions, exactly like Linear's issue labels: each group is one dimension (a phase, an area), its labels are the states a session can be in. New sessions start with the group's default label; skills instruct sessions to relabel themselves as work progresses, and router-visible groups help the session router match incoming comments to the right session."
      >
        <LabelsSection id={id} value={value} mutate={mutate} />
      </SettingsSection>
    </Accordion>
  );
}
