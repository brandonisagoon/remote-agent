import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

type Repository = ServiceFile["repositories"][string];

const KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Group names are JSON map keys; renaming rewrites both the definition and
    its defaults, committed on blur so half-typed names never hit the draft. */
function GroupNameInput({
  repositoryId,
  groupKey,
  existing,
  autoFocus,
  mutate,
}: {
  repositoryId: string;
  groupKey: string;
  existing: string[];
  autoFocus: boolean;
  mutate: Mutate;
}) {
  const [value, setValue] = useState(groupKey);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(groupKey), [groupKey]);
  useEffect(() => {
    if (autoFocus) inputRef.current?.select();
  }, [autoFocus]);
  const commit = () => {
    const next = value.trim();
    if (next === groupKey) return;
    if (!KEY_PATTERN.test(next) || existing.includes(next)) {
      setValue(groupKey);
      toast.error(
        KEY_PATTERN.test(next) ? "A group with this name already exists" : "Group names are lowercase letters, digits, and ._-",
      );
      return;
    }
    mutate((file) => {
      const repository = file.repositories[repositoryId]!;
      repository.labels = Object.fromEntries(
        Object.entries(repository.labels).map(([key, definition]) =>
          key === groupKey ? [next, definition] : [key, definition],
        ),
      );
      if (repository.sessionDefaults.labels[groupKey]) {
        repository.sessionDefaults.labels[next] = repository.sessionDefaults.labels[groupKey]!;
        delete repository.sessionDefaults.labels[groupKey];
      }
    });
  };
  return (
    <Input
      ref={inputRef}
      className="h-7 w-56 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
    />
  );
}

/** One label group: a collapsed header row; expanding lists its labels as
    indented rows. Row actions live behind hover controls, like Linear's
    label settings. */
function LabelGroup({
  repositoryId,
  groupKey,
  value,
  isNew,
  mutate,
}: {
  repositoryId: string;
  groupKey: string;
  value: ServiceFile;
  isNew: boolean;
  mutate: Mutate;
}) {
  const repository = value.repositories[repositoryId]!;
  const definition = repository.labels[groupKey]!;
  const defaults = repository.sessionDefaults.labels[groupKey] ?? [];
  const [expanded, setExpanded] = useState(isNew);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const edit = (change: (repository: Repository) => void) =>
    mutate((file) => { change(file.repositories[repositoryId]!); });

  const addLabel = () => {
    const next = draft.trim();
    setDraft("");
    setAdding(false);
    if (!next) return;
    if (definition.labels?.includes(next)) {
      toast.error("This label already exists");
      return;
    }
    edit((repository) => {
      const target = repository.labels[groupKey]!;
      target.labels = [...(target.labels ?? []), next];
    });
  };

  const removeLabel = (option: string) => {
    edit((repository) => {
      const target = repository.labels[groupKey]!;
      const options = (target.labels ?? []).filter((entry) => entry !== option);
      if (options.length > 0) target.labels = options;
      else delete target.labels;
      const remaining = (repository.sessionDefaults.labels[groupKey] ?? []).filter((entry) => entry !== option);
      if (remaining.length > 0) repository.sessionDefaults.labels[groupKey] = remaining;
      else delete repository.sessionDefaults.labels[groupKey];
    });
  };

  // Exclusive groups hold one launch default, non-exclusive ones a set.
  const toggleDefault = (option: string) => {
    edit((repository) => {
      const current = repository.sessionDefaults.labels[groupKey] ?? [];
      const next = current.includes(option)
        ? current.filter((entry) => entry !== option)
        : definition.exclusive
          ? [option]
          : [...current, option];
      if (next.length > 0) repository.sessionDefaults.labels[groupKey] = next;
      else delete repository.sessionDefaults.labels[groupKey];
    });
  };

  const labels = definition.labels ?? [];

  return (
    <>
      {/* Group header row */}
      <div className="group/row hover:bg-muted/50 flex h-11 items-center gap-2 px-4">
        <button
          type="button"
          className="text-muted-foreground/70 hover:text-foreground flex size-4 shrink-0 items-center justify-center"
          onClick={() => setExpanded((current) => !current)}
        >
          <F7Icon
            name="chevron_right"
            className={cn("size-2.5 transition-none", expanded && "rotate-90")}
          />
          <span className="sr-only">{expanded ? "Collapse" : "Expand"}</span>
        </button>
        <GroupNameInput
          repositoryId={repositoryId}
          groupKey={groupKey}
          existing={Object.keys(repository.labels).filter((key) => key !== groupKey)}
          autoFocus={isNew}
          mutate={mutate}
        />
        <Input
          className="text-muted-foreground h-7 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder="Add description…"
          value={definition.description ?? ""}
          onChange={(event) => edit((repository) => {
            const next = event.target.value;
            if (next) repository.labels[groupKey]!.description = next;
            else delete repository.labels[groupKey]!.description;
          })}
        />
        <span className="text-muted-foreground/70 shrink-0 text-xs tabular-nums">
          {labels.length === 0 ? "free text" : `${labels.length} label${labels.length === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                onClick={() => {
                  setExpanded(true);
                  setAdding(true);
                  setDraft("");
                }}
              >
                <F7Icon name="plus" className="size-3.5" />
                <span className="sr-only">New Label</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>New Label</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-6">
                <F7Icon name="ellipsis" className="size-3.5" />
                <span className="sr-only">Group Options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={definition.exclusive}
                onCheckedChange={(next) => edit((repository) => {
                  repository.labels[groupKey]!.exclusive = next;
                })}
              >
                Exclusive
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={definition.routerVisible}
                onCheckedChange={(next) => edit((repository) => {
                  repository.labels[groupKey]!.routerVisible = next;
                })}
              >
                Router visible
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => edit((repository) => {
                  delete repository.labels[groupKey];
                  delete repository.sessionDefaults.labels[groupKey];
                })}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/* Label rows */}
      {expanded &&
        labels.map((option) => {
          const isDefault = defaults.includes(option);
          return (
            <div key={option} className="group/row hover:bg-muted/50 flex h-10 items-center gap-2 pr-4 pl-10">
              <span className="truncate text-sm">{option}</span>
              {isDefault && <span className="text-muted-foreground/70 text-xs">default</span>}
              <div className="ml-auto opacity-0 group-hover/row:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-6">
                      <F7Icon name="ellipsis" className="size-3.5" />
                      <span className="sr-only">Label Options</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => toggleDefault(option)}>
                      {isDefault ? "Unset default" : "Make default"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => removeLabel(option)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
      {expanded && labels.length === 0 && !adding && (
        <div className="text-muted-foreground flex h-10 items-center pr-4 pl-10 text-xs">
          No labels — sessions may use any value.
        </div>
      )}
      {expanded && adding && (
        <div className="flex h-10 items-center gap-2 pr-4 pl-10">
          <Input
            autoFocus
            className="h-7 w-64 text-sm"
            placeholder="Label name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={addLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") addLabel();
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
        </div>
      )}
    </>
  );
}

export function LabelsSection({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const keys = Object.keys(repository.labels);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  return (
    <>
      <div className="bg-background -mx-4 rounded-lg border">
        {keys.map((key) => (
          <div key={key} className="border-b last:border-b-0">
            <LabelGroup
              repositoryId={id}
              groupKey={key}
              value={value}
              isNew={key === newGroup}
              mutate={mutate}
            />
          </div>
        ))}
        {keys.length === 0 && (
          <div className="text-muted-foreground p-6 text-center text-sm">
            No label groups yet.
          </div>
        )}
        {/* macOS System Settings-style footer bar */}
        <div className="flex items-center border-t px-1 py-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  let key = "new-group";
                  for (let index = 1; repository.labels[key]; index += 1) key = `new-group-${index}`;
                  mutate((file) => {
                    file.repositories[id]!.labels[key] = { exclusive: true, routerVisible: false };
                  });
                  setNewGroup(key);
                }}
              >
                <F7Icon name="plus" className="size-3.5" />
                <span className="sr-only">New Group</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>New Group</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
