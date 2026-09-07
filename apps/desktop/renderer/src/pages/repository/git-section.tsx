import type { ServiceFile } from "../../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

/** Structural preview: the template's literal text with each {placeholder}
    shown as a token — no invented sample data. `flatten` applies the
    worktree directory transform to the literal segments. */
function TemplatePreview({ template, suffix }: {
  template: string;
  suffix?: string;
}) {
  const segments = template.split(/(\{(?:branch|issue|title)\})/g).filter(Boolean);
  return (
    <span>
      {segments.map((segment, index) => {
        const placeholder = /^\{(branch|issue|title)\}$/.exec(segment);
        return placeholder ? (
          <span key={index} className="bg-muted text-foreground/70 rounded px-1">
            {placeholder[1]}
          </span>
        ) : (
          <span key={index}>{segment}</span>
        );
      })}
      {suffix}
    </span>
  );
}

function PathField({ label, title, value, onChange }: {
  label: string;
  title: string;
  value: string;
  onChange(next: string): void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <InputGroup>
        <InputGroupInput value={value} onChange={(event) => onChange(event.target.value)} />
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton
                size="icon-xs"
                onClick={async () => {
                  const picked = await window.remoteAgent.fs.pickFolder(title, value);
                  if (picked) onChange(picked);
                }}
              >
                <F7Icon name="folder" />
                <span className="sr-only">{title}</span>
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>Choose Folder</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

/** One per-connection template table: an always-present "All connections"
    row (`*`) plus overrides added from the footer bar. Shared by worktree
    and branch naming so the two present identically. */
function NamingTable({ label, naming, connections, preview, legend, onChange }: {
  label: string;
  naming: Record<string, string>;
  connections: ServiceFile["connections"];
  preview(template: string): React.ReactNode;
  legend: React.ReactNode;
  onChange(next: Record<string, string>): void;
}) {
  const overrideIds = Object.keys(naming).filter((key) => key !== "*");
  const addable = Object.keys(connections).filter((connectionId) => !(connectionId in naming));

  const row = (key: string) => {
    const template = naming[key] ?? "{branch}";
    return (
      <TableRow key={key} className="group h-14">
        <TableCell className="w-44 truncate pl-4">
          {key === "*" ? "All connections" : (connections[key]?.name ?? key)}
        </TableCell>
        <TableCell>
          <Input
            className="bg-background h-8 font-mono text-xs"
            value={template}
            onChange={(event) => onChange({ ...naming, [key]: event.target.value })}
          />
        </TableCell>
        <TableCell className="text-muted-foreground w-72 truncate font-mono text-xs">
          {preview(template)}
        </TableCell>
        <TableCell className="w-10 pr-2 text-right">
          {key !== "*" && (
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive size-8 opacity-0 group-hover:opacity-100"
              onClick={() => {
                const next = { ...naming };
                delete next[key];
                onChange(next);
              }}
            >
              <F7Icon name="xmark" />
              <span className="sr-only">Remove Override</span>
            </Button>
          )}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="bg-background -mx-4 rounded-lg border">
        <Table className="table-fixed">
          <TableBody>
            {row("*")}
            {overrideIds.map(row)}
          </TableBody>
        </Table>
        {/* macOS System Settings-style footer bar */}
        <div className="flex items-center border-t px-1 py-0.5">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6" disabled={addable.length === 0}>
                    <F7Icon name="plus" className="size-3.5" />
                    <span className="sr-only">New Connection Override</span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>New Connection Override</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              {addable.map((connectionId) => (
                <DropdownMenuItem
                  key={connectionId}
                  onSelect={() => onChange({ ...naming, [connectionId]: "{branch}" })}
                >
                  {connections[connectionId]?.name ?? connectionId}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{legend}</p>
    </div>
  );
}

export function GitSection({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const branchNaming = repository.branchNaming ?? { "*": "{branch}" };
  const worktreeNaming = repository.worktreeNaming ?? { "*": "{branch}" };
  const edit = (change: (repo: ServiceFile["repositories"][string]) => void) =>
    mutate((file) => { change(file.repositories[id]!); });

  return (
    <SettingsSection
      value="git"
      title="Git"
      description="Where sessions check out and how their worktrees and branches are named."
    >
      <SettingsCard>
        <Field label="Display name" value={repository.name ?? id} onChange={(next) => edit((repo) => { repo.name = next; })} />
        <PathField label="Checkout root" title="Select Checkout Root" value={repository.root} onChange={(next) => edit((repo) => { repo.root = next; })} />
        <PathField label="Worktree root" title="Select Worktree Root" value={repository.worktreeRoot} onChange={(next) => edit((repo) => { repo.worktreeRoot = next; })} />
      </SettingsCard>
      <NamingTable
        label="Worktree naming"
        naming={worktreeNaming}
        connections={value.connections}
        preview={(template) => <TemplatePreview template={template} suffix="/" />}
        legend={
          <>
            {"{branch}"} the app's suggested branch · {"{issue}"} the
            identifier · {"{title}"} the title.
          </>
        }
        onChange={(next) => edit((repo) => { repo.worktreeNaming = next; })}
      />
      <NamingTable
        label="Branch naming"
        naming={branchNaming}
        connections={value.connections}
        preview={(template) => <TemplatePreview template={template} />}
        legend={
          <>
            {"{branch}"} the app's suggested branch · {"{issue}"} the
            identifier · {"{title}"} the title · keep {"{branch}"} or{" "}
            {"{issue}"}.
          </>
        }
        onChange={(next) => edit((repo) => { repo.branchNaming = next; })}
      />
    </SettingsSection>
  );
}

/** `.sh` → bash, `.ts`/`.js` → bun, anything else runs directly. */
function commandForScript(relativePath: string): string[] {
  if (relativePath.endsWith(".sh")) return ["bash", relativePath];
  if (/\.(ts|js|mjs|mts)$/.test(relativePath)) return ["bun", relativePath];
  return [relativePath.startsWith("/") ? relativePath : `./${relativePath}`];
}

export function BootstrapSection({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  return (
    <SettingsSection
      value="bootstrap"
      title="Bootstrap"
      description="How a fresh worktree gets ready."
    >
      <SettingsCard>
        <div className="grid gap-2">
          <Label>Bootstrap command</Label>
          <InputGroup>
            <InputGroupInput
              value={repository.bootstrapCommand.join(" ")}
              onChange={(event) => mutate((file) => {
                file.repositories[id]!.bootstrapCommand = event.target.value.split(/\s+/).filter(Boolean);
              })}
            />
            <InputGroupAddon align="inline-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    size="icon-xs"
                    onClick={async () => {
                      const picked = await window.remoteAgent.fs.pickFile("Select Bootstrap Script", repository.root);
                      if (!picked) return;
                      const relative = picked.startsWith(`${repository.root}/`)
                        ? picked.slice(repository.root.length + 1)
                        : picked;
                      mutate((file) => {
                        file.repositories[id]!.bootstrapCommand = commandForScript(relative);
                      });
                    }}
                  >
                    <F7Icon name="doc_text" />
                    <span className="sr-only">Choose Bootstrap Script</span>
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>Choose Script</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
          <p className="text-muted-foreground text-xs">
            Runs once in each new worktree, after checkout, before the
            session · non-zero exit fails the launch.
          </p>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
