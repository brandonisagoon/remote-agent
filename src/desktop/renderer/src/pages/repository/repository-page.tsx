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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { sessionsQueryOptions } from "@renderer/lib/queries/sessions.ts";
import { SkillsTab } from "./skills-tab.tsx";
import { WorkflowsSection } from "./workflows-section.tsx";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

export function RepositoryPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id];
  if (!repository) return <PageHeading title="Repository not found" description={id} />;
  return (
    <div className="grid gap-6">
      <p className="text-muted-foreground truncate font-mono text-xs">{repository.root}</p>
      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="settings">Repository Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="pt-4">
          <SessionsTab repositoryId={id} />
        </TabsContent>
        <TabsContent value="skills" className="pt-4">
          <SkillsTab id={id} value={value} mutate={mutate} />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <RepositorySettings id={id} value={value} mutate={mutate} />
        </TabsContent>
      </Tabs>
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
                <TableHead>Tags</TableHead>
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
                      {session.tags.map((tag) => (
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
    <Accordion type="multiple" defaultValue={["paths", "workflows", "metadata"]} className="-mt-3">
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
        value="metadata"
        title="Metadata definitions"
        description="String-only tags configured for this repository. Use the JSON editor for advanced editing."
      >
        <SettingsCard>
          {Object.entries(repository.metadata.tags).map(([key, definition]) => (
            <div key={key} className="bg-background flex items-center gap-3 rounded-md border px-4 py-3">
              <code className="text-xs">{key}</code>
              <Badge variant="secondary">{definition.cardinality}</Badge>
              {definition.routerVisible && <Badge variant="outline">router visible</Badge>}
              <span className="text-muted-foreground ml-auto text-xs">
                {definition.options?.join(", ") ?? "free text"}
              </span>
            </div>
          ))}
          {Object.keys(repository.metadata.tags).length === 0 && (
            <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
              No custom metadata definitions.
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}
