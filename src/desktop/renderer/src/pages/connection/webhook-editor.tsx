import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { SecretField } from "@renderer/components/secret-field.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

type ConnectionWebhook = NonNullable<ServiceFile["connections"][string]["webhook"]>;

export function WebhookEditor({
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
