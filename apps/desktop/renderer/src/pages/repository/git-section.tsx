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
import type { RepoConfigDraft } from "@renderer/lib/config-context.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

/** Structural preview: the template's literal text with each {placeholder}
    shown as a token — no invented sample data. */
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

function namingKeyLabel(key: string): string {
  if (key === "*") return "All";
  const [provider, workspace] = key.split(":");
  const name = provider === "linear" ? "Linear" : (provider ?? key);
  return workspace ? `${name} · ${workspace}` : name;
}

/** Branch templates keyed by portable identifiers ("*", provider,
    provider:workspace) — committed to the repository, so machine-local
    connection ids never appear. */
function BranchNamingTable({ repo }: { repo: RepoConfigDraft }) {
  const naming = repo.config?.branchNaming ?? { "*": "{branch}" };
  const keys = ["*", ...Object.keys(naming).filter((key) => key !== "*").sort()];

  const row = (key: string) => {
    const template = naming[key] ?? "{branch}";
    return (
      <TableRow key={key} className="group h-14">
        <TableCell className="w-44 truncate pl-4">{namingKeyLabel(key)}</TableCell>
        <TableCell>
          <Input
            className="bg-background h-8 font-mono text-xs"
            value={template}
            onChange={(event) => repo.mutate((config) => {
              config.branchNaming = { ...config.branchNaming, [key]: event.target.value };
            })}
          />
        </TableCell>
        <TableCell className="text-muted-foreground w-72 truncate font-mono text-xs">
          <TemplatePreview template={template} />
        </TableCell>
        <TableCell className="w-10 pr-2 text-right">
          {key !== "*" && (
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive size-8 opacity-0 group-hover:opacity-100"
              onClick={() => repo.mutate((config) => {
                const next = { ...config.branchNaming };
                delete next[key];
                config.branchNaming = next;
              })}
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
      <Label>Branch naming</Label>
      <div className="bg-background -mx-4 rounded-lg border">
        <Table className="table-fixed">
          <TableBody>{keys.map(row)}</TableBody>
        </Table>
        {/* macOS System Settings-style footer bar */}
        <div className="flex items-center border-t px-1 py-0.5">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6">
                    <F7Icon name="plus" className="size-3.5" />
                    <span className="sr-only">New Override</span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>New Override</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                disabled={"linear" in naming}
                onSelect={() => repo.mutate((config) => {
                  config.branchNaming = { ...config.branchNaming, linear: "{branch}" };
                })}
              >
                Linear — any workspace
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => repo.mutate((config) => {
                  let key = "linear:workspace";
                  let counter = 2;
                  while (key in config.branchNaming) key = `linear:workspace-${counter++}`;
                  config.branchNaming = { ...config.branchNaming, [key]: "{branch}" };
                })}
              >
                Linear — one workspace…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {'"linear"'} matches any Linear connection ·{" "}
        {'"linear:<workspace>"'} matches connections whose workspace field
        says so · {"{branch}"} the app's suggested branch · {"{issue}"} the
        identifier · {"{title}"} the title · keep {"{branch}"} or {"{issue}"}.
      </p>
    </div>
  );
}

/** Worktree directory templates keyed by connection — machine-local taste,
    so machine-local connection ids are legitimate keys here. */
function WorktreeNamingTable({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const naming = repository.worktreeNaming ?? { "*": "{branch}" };
  const keys = ["*", ...Object.keys(naming).filter((key) => key !== "*").sort()];
  const addable = Object.keys(value.connections).filter((connectionId) => !(connectionId in naming));
  const edit = (change: (entry: ServiceFile["repositories"][string]) => void) =>
    mutate((file) => { change(file.repositories[id]!); });

  const row = (key: string) => {
    const template = naming[key] ?? "{branch}";
    return (
      <TableRow key={key} className="group h-14">
        <TableCell className="w-44 truncate pl-4">
          {key === "*" ? "All connections" : (value.connections[key]?.name ?? key)}
        </TableCell>
        <TableCell>
          <Input
            className="bg-background h-8 font-mono text-xs"
            value={template}
            onChange={(event) => edit((entry) => {
              entry.worktreeNaming = { ...entry.worktreeNaming, [key]: event.target.value };
            })}
          />
        </TableCell>
        <TableCell className="text-muted-foreground w-72 truncate font-mono text-xs">
          <TemplatePreview template={template} suffix="/" />
        </TableCell>
        <TableCell className="w-10 pr-2 text-right">
          {key !== "*" && (
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive size-8 opacity-0 group-hover:opacity-100"
              onClick={() => edit((entry) => {
                const next = { ...entry.worktreeNaming };
                delete next[key];
                entry.worktreeNaming = next;
              })}
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
      <Label>Worktree naming</Label>
      <div className="bg-background -mx-4 rounded-lg border">
        <Table className="table-fixed">
          <TableBody>{keys.map(row)}</TableBody>
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
                  onSelect={() => edit((entry) => {
                    entry.worktreeNaming = { ...entry.worktreeNaming, [connectionId]: "{branch}" };
                  })}
                >
                  {value.connections[connectionId]?.name ?? connectionId}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        This machine's folder names under the worktree root. {"{branch}"} the
        app's suggested branch · {"{issue}"} the identifier · {"{title}"} the
        title.
      </p>
    </div>
  );
}

export function GitSection({ id, value, mutate, repo }: {
  id: string;
  value: ServiceFile;
  mutate: Mutate;
  repo: RepoConfigDraft;
}) {
  const repository = value.repositories[id]!;
  const edit = (change: (entry: ServiceFile["repositories"][string]) => void) =>
    mutate((file) => { change(file.repositories[id]!); });

  return (
    <SettingsSection
      value="git"
      title="Git"
      description="Where sessions check out and how their worktrees and branches are named."
    >
      <SettingsCard>
        <Field label="Display name" value={repository.name ?? id} onChange={(next) => edit((entry) => { entry.name = next; })} />
        <PathField label="Checkout root" title="Select Checkout Root" value={repository.root} onChange={(next) => edit((entry) => { entry.root = next; })} />
        <PathField label="Worktree root" title="Select Worktree Root" value={repository.worktreeRoot} onChange={(next) => edit((entry) => { entry.worktreeRoot = next; })} />
      </SettingsCard>
      <WorktreeNamingTable id={id} value={value} mutate={mutate} />
      {repo.config && <BranchNamingTable repo={repo} />}
    </SettingsSection>
  );
}

/** `.sh` → bash, `.ts`/`.js` → bun, anything else runs directly. */
function commandForScript(relativePath: string): string[] {
  if (relativePath.endsWith(".sh")) return ["bash", relativePath];
  if (/\.(ts|js|mjs|mts)$/.test(relativePath)) return ["bun", relativePath];
  return [relativePath.startsWith("/") ? relativePath : `./${relativePath}`];
}

export function BootstrapSection({ root, repo }: { root: string; repo: RepoConfigDraft }) {
  const command = repo.config?.bootstrapCommand ?? [];
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
              value={command.join(" ")}
              onChange={(event) => repo.mutate((config) => {
                config.bootstrapCommand = event.target.value.split(/\s+/).filter(Boolean);
              })}
            />
            <InputGroupAddon align="inline-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    size="icon-xs"
                    onClick={async () => {
                      const picked = await window.remoteAgent.fs.pickFile("Select Bootstrap Script", root);
                      if (!picked) return;
                      const relative = picked.startsWith(`${root}/`)
                        ? picked.slice(root.length + 1)
                        : picked;
                      repo.mutate((config) => {
                        config.bootstrapCommand = commandForScript(relative);
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
