import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../lib/config.ts";
import { CopyField } from "@renderer/components/copy-field.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { SecretField } from "@renderer/components/secret-field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Checkbox } from "@renderer/components/ui/checkbox.tsx";
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
import type { Mutate } from "@renderer/lib/types.ts";

export function ConnectionPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const connection = value.connections[id];
  if (!connection) return <PageHeading title="Connection not found" description={id} />;
  return (
    <Accordion type="multiple" defaultValue={["general", "authentication", "agent"]} className="-mt-4">
      <SettingsSection value="general" title="General">
        <SettingsCard>
          <Field label="Display name" value={connection.name} onChange={(next) => mutate((file) => { file.connections[id]!.name = next; })} />
          <CopyField label="Connection ID" value={id} />
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
            , then register the webhook URL and secret below in the same place. The webhook is
            served by the selected machine and only accepts events for the checked repositories.
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
    </Accordion>
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
  const routingMode = webhook.repositories === "*" ? "all" : "select";
  const routingTargets =
    webhook.repositories === "*" ? Object.keys(value.repositories) : Object.keys(webhook.repositories);
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
  const toggleRepository = (repositoryId: string, checked: boolean) => {
    mutate((file) => {
      const hook = file.connections[connectionId]!.webhook!;
      const routing = hook.repositories === "*"
        ? Object.fromEntries(Object.keys(file.repositories).map((repo) => [repo, {}]))
        : hook.repositories;
      if (checked) routing[repositoryId] = routing[repositoryId] ?? {};
      else delete routing[repositoryId];
      hook.repositories = routing;
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
                <Select value={webhook.machineId} disabled>
                  <SelectTrigger className="w-full border-0 bg-transparent shadow-none dark:bg-transparent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={webhook.machineId}>{value.machine.name}</SelectItem>
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
              const hook = file.connections[connectionId]!.webhook!;
              if (mode === "all") {
                hook.repositories = "*";
              } else if (hook.repositories === "*") {
                hook.repositories = Object.fromEntries(
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
                webhook.repositories !== "*" && (webhook.repositories[repositoryId]?.when?.length ?? 0) > 0;
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
