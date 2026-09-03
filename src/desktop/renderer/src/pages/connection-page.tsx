import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../lib/config.ts";
import { sshLinkSupported } from "../../../../lib/machines/editor-link.ts";
import { CopyField } from "@renderer/components/copy-field.tsx";
import { JsonBlock } from "@renderer/components/json-block.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SecretField } from "@renderer/components/secret-field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
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
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Checkbox } from "@renderer/components/ui/checkbox.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import { providerModelsQueryOptions } from "@renderer/lib/queries/provider-models.ts";
import type { Mutate } from "@renderer/lib/types.ts";

/** Live model options scanned from the installed provider binary (main
    process), so upgrading the CLI updates the list. Falls back to a curated
    set; the JSON accepts any string either way. */
function useProviderModels(providerId: string, currentModel: string | null): string[] {
  const { data: models = [] } = useQuery(providerModelsQueryOptions(providerId));
  if (currentModel && !models.includes(currentModel)) return [currentModel, ...models];
  return models;
}

export function ConnectionPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const connection = value.connections[id];
  const routerModels = useProviderModels(
    connection?.router.providerId ?? "codex",
    connection?.router.model ?? null,
  );
  if (!connection) return <PageHeading title="Connection not found" description={id} />;
  return (
    <Accordion type="multiple" defaultValue={["general", "machine", "authentication", "agent", "router", "editor"]} className="-mt-4">
      <SettingsSection value="general" title="General">
        <SettingsCard>
          <Field label="Display name" value={connection.name} onChange={(next) => mutate((file) => { file.connections[id]!.name = next; })} />
          <CopyField label="Connection ID" value={id} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="machine"
        title="Machine"
        description="Where this workspace's sessions run, and which repositories they may work in."
      >
        <SettingsCard>
          <MachineScopeEditor connectionId={id} value={value} mutate={mutate} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="authentication"
        title="Authentication"
        description={
          <>
            Paste in an API key from your{" "}
            <a
              href="https://linear.app/settings/api"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              Linear API settings
            </a>
            , then register the webhook URL and secret below in the same place.
          </>
        }
      >
        <SettingsCard>
          <SecretField label="Linear API key" value={connection.apiKey} onChange={(next) => mutate((file) => { file.connections[id]!.apiKey = next; })} />
          {/* healConfig guarantees the webhook exists after adoption; the guard
              only covers the render between adoption and heal-save. */}
          {connection.webhook && (
            <WebhookEditor connectionId={id} webhook={connection.webhook} value={value} mutate={mutate} />
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="agent"
        title="Agent"
        description="The Linear user this agent acts as — assigning or mentioning it is what triggers sessions."
      >
        <SettingsCard>
          <Field label="Agent user ID" value={connection.agentUserId} onChange={(next) => mutate((file) => { file.connections[id]!.agentUserId = next; })} />
          <Field label="Agent handle" value={connection.agentHandle ?? ""} onChange={(next) => mutate((file) => { file.connections[id]!.agentHandle = next || undefined; })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="router"
        title="Session Router"
        description="Several sessions can run at once. When a comment or event arrives from Linear, this model reads it alongside the session database and picks the matching session. The event is then delivered into that session as a prompt. Its only output is a routing decision — it has no tools or repository access, and never replies to Linear or starts sessions itself."
      >
        <JsonBlock
          label="Example Input from Linear"
          json={`{
  "comment": "@agent fix the flaky auth test",
  "candidates": [
    { "agentIssueIdentifier": "AGENT-130", "status": "Connected", "role": "primary" },
    { "agentIssueIdentifier": "AGENT-131", "status": "Working",   "role": "primary" }
  ]
}`}
        />
        <JsonBlock
          label="Example Routing Decision"
          json={`{
  "targetAgentIssueIdentifier": "AGENT-131",
  "reasonCode": "primary_session",
  "confidence": 0.9,
  "expectedActions": ["code_change"],
  "replyToCommentId": null
}`}
        />
        <SettingsCard>
          <div className="grid gap-2">
            <Label>Provider</Label>
            <Select
              value={connection.router.providerId}
              onValueChange={(next) => mutate((file) => { file.connections[id]!.router.providerId = next as "codex" | "claude"; })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">{PROVIDER_LABELS["codex"]}</SelectItem>
                <SelectItem value="claude">{PROVIDER_LABELS["claude"]}</SelectItem>
              </SelectContent>
            </Select>
            {!(connection.router.providerId in value.providers) && (
              <p className="text-muted-foreground text-xs">
                Not configured as a provider yet — the default `codex` binary is used.
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label>Model</Label>
            <Select
              value={connection.router.model ?? "default"}
              onValueChange={(next) => mutate((file) => { file.connections[id]!.router.model = next === "default" ? undefined : next; })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Provider default</SelectItem>
                {routerModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        value="editor"
        title="Editor Deep Links"
        description="Open a session's worktree in your editor straight from Linear."
      >
        <SettingsCard>
          <div className="bg-background rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[45%]">Editor</TableHead>
                  <TableHead>Deep Link</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connection.editors.map((editor, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <Input
                        className="h-8"
                        placeholder="Code Editor"
                        aria-invalid={!editor.name}
                        value={editor.name}
                        onChange={(event) =>
                          mutate((file) => {
                            file.connections[id]!.editors[index]!.name = event.target.value;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <InputGroup className="h-8">
                        <InputGroupInput
                          className="w-auto flex-none pr-0! font-mono field-sizing-content"
                          placeholder="scheme"
                          aria-invalid={!editor.scheme}
                          value={editor.scheme}
                          onChange={(event) =>
                            mutate((file) => {
                              file.connections[id]!.editors[index]!.scheme = event.target.value;
                            })
                          }
                        />
                        {/* Content-sized input keeps :// attached to the typed
                            scheme; the addon fills the rest so clicks focus. */}
                        <InputGroupAddon align="inline-end" className="flex-1 justify-start pl-0">
                          <InputGroupText className="font-mono">://</InputGroupText>
                        </InputGroupAddon>
                      </InputGroup>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-7"
                        onClick={() => mutate((file) => { file.connections[id]!.editors.splice(index, 1); })}
                      >
                        <F7Icon name="trash" />
                        <span className="sr-only">Remove Editor</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {connection.editors.length === 0 && (
              <div className="text-muted-foreground p-6 text-center text-sm">
                No editors — worktree links won't be posted.
              </div>
            )}
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                mutate((file) => {
                  file.connections[id]!.editors.push({ name: "", scheme: "" });
                })
              }
            >
              <F7Icon name="plus" />
              Add Editor
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}

function MachineScopeEditor({
  connectionId,
  value,
  mutate,
}: {
  connectionId: string;
  value: ServiceFile;
  mutate: Mutate;
}) {
  const connection = value.connections[connectionId]!;
  const repositories = connection.repositories;
  const routingMode = repositories === "*" ? "all" : "select";
  const routingTargets =
    repositories === "*" ? Object.keys(value.repositories) : Object.keys(repositories);
  const toggleRepository = (repositoryId: string, checked: boolean) => {
    mutate((file) => {
      const scope = file.connections[connectionId]!;
      const routing = scope.repositories === "*"
        ? Object.fromEntries(Object.keys(file.repositories).map((repo) => [repo, {}]))
        : scope.repositories;
      if (checked) routing[repositoryId] = routing[repositoryId] ?? {};
      else delete routing[repositoryId];
      scope.repositories = routing;
    });
  };
  return (
    <>
      <div className="grid gap-2">
        <Label>Machine</Label>
        <InputGroup>
          {/* Span wrapper: the disabled trigger swallows pointer events, so the
              tooltip listens on a live ancestor instead. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-1">
                <Select value={connection.machineId ?? value.machine.id} disabled>
                  <SelectTrigger className="w-full border-0 bg-transparent shadow-none dark:bg-transparent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={connection.machineId ?? value.machine.id}>{value.machine.name}</SelectItem>
                  </SelectContent>
                </Select>
              </span>
            </TooltipTrigger>
            <TooltipContent>Multi-machine support coming soon</TooltipContent>
          </Tooltip>
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <InputGroupButton size="icon-xs" asChild>
                  <Link to="/">
                    <F7Icon name="desktopcomputer" />
                    <span className="sr-only">Open machine settings</span>
                  </Link>
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>Machine Settings</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className="grid gap-2">
        <Label>Repositories</Label>
        <Tabs
          value={routingMode}
          onValueChange={(mode) => {
            mutate((file) => {
              const scope = file.connections[connectionId]!;
              if (mode === "all") {
                scope.repositories = "*";
              } else if (scope.repositories === "*") {
                scope.repositories = Object.fromEntries(
                  Object.keys(file.repositories).map((repositoryId) => [repositoryId, {}]),
                );
              }
            });
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="select">Selected</TabsTrigger>
          </TabsList>
        </Tabs>
        {routingMode === "select" && (
          <div className="grid grid-cols-2 gap-2 pt-2 pb-4">
            {Object.entries(value.repositories).map(([repositoryId, repository]) => {
              const checked = routingTargets.includes(repositoryId);
              const conditional =
                repositories !== "*" && (repositories[repositoryId]?.when?.length ?? 0) > 0;
              return (
                <label key={repositoryId} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    disabled={checked && routingTargets.length === 1}
                    onCheckedChange={(next) => toggleRepository(repositoryId, next === true)}
                  />
                  <span className="truncate">{repository.name ?? repositoryId}</span>
                  {conditional && <span className="text-muted-foreground text-xs">(conditional)</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

type ConnectionWebhook = NonNullable<ServiceFile["connections"][string]["webhook"]>;

function WebhookEditor({
  connectionId,
  webhook,
  value,
  mutate,
}: {
  connectionId: string;
  webhook: ConnectionWebhook;
  value: ServiceFile;
  mutate: Mutate;
}) {
  const urlPrefix = `${value.machine.server.publicUrl.replace(/\/$/, "")}/webhooks/`;

  const [slug, setSlug] = useState(webhook.slug);
  useEffect(() => setSlug(webhook.slug), [webhook.slug]);
  const renameWebhook = () => {
    const next = slug.trim();
    if (next === webhook.slug) return;
    const valid = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(next);
    const taken = Object.values(value.connections).some((other) => other.webhook?.slug === next);
    if (!valid || taken) {
      setSlug(webhook.slug);
      toast.error(valid ? "A webhook with this slug already exists" : "Slug must be lowercase letters, digits, and ._-");
      return;
    }
    mutate((file) => {
      file.connections[connectionId]!.webhook!.slug = next;
    });
  };
  const copyUrl = async () => {
    await navigator.clipboard.writeText(`${urlPrefix}${webhook.slug}`);
    toast.success("Webhook URL copied");
  };
  return (
    <>
      <div className="grid gap-2">
        <Label>Webhook URL</Label>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <InputGroupText className="text-muted-foreground">{urlPrefix}</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            value={slug}
            className="pl-0!"
            onChange={(event) => setSlug(event.target.value)}
            onBlur={renameWebhook}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <InputGroupButton size="icon-xs" onClick={() => void copyUrl()}>
                  <F7Icon name="doc_on_doc" />
                  <span className="sr-only">Copy Webhook URL</span>
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
        <p className="text-muted-foreground text-xs">
          Paste this into Linear's webhook settings and enable the Issues, Comments, and Reactions events.
        </p>
      </div>
      <SecretField
        label="Webhook secret"
        value={webhook.secret}
        onChange={(next) => mutate((file) => { file.connections[connectionId]!.webhook!.secret = next; })}
      />
    </>
  );
}
