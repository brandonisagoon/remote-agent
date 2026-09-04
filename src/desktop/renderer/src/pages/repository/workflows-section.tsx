import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Checkbox } from "@renderer/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { skillsQueryOptions } from "@renderer/lib/queries/skills.ts";
import { randomHex } from "@renderer/lib/random.ts";
import type { Mutate } from "@renderer/lib/types.ts";

type Workflow = ServiceFile["repositories"][string]["workflows"][string];

const EVENT_LABELS: Record<Workflow["on"], string> = {
  "issue.state-changed": "Issue enters state",
  "issue.reaction": "Issue reaction",
};

/** The condition field each event type filters on. Richer conditions stay
    JSON-editable; the UI covers the common single-field case. */
const EVENT_CONDITION_FIELD: Record<Workflow["on"], string> = {
  "issue.state-changed": "issue.state",
  "issue.reaction": "reaction.emoji",
};

function conditionSummary(workflow: Workflow): string {
  if (!workflow.when || workflow.when.length === 0) return "always";
  const field = EVENT_CONDITION_FIELD[workflow.on];
  const values = workflow.when.flatMap((condition) => condition[field] ?? []);
  return values.length > 0 ? values.join(", ") : "custom conditions";
}

export function WorkflowsSection({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      <div className="bg-background -mx-4 rounded-lg border">
        <Table className="table-fixed">
          <TableBody>
            {Object.entries(repository.workflows).map(([workflowId, workflow]) => (
              <TableRow key={workflowId} className="h-14">
                <TableCell className="pl-4">
                  <div>{workflowId}</div>
                  <div className="text-muted-foreground truncate text-xs">
                    {EVENT_LABELS[workflow.on]}: {conditionSummary(workflow)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="truncate font-mono text-xs">
                    {workflow.skill.skillset}
                    {workflow.skill.flags.length > 0 && `+${workflow.skill.flags.join("+")}`}
                  </div>
                  <div className="text-muted-foreground/70 text-xs">
                    {workflow.deliver === "start-session" ? "starts a session" : "messages the session"}
                  </div>
                </TableCell>
                <TableCell className="w-40 pr-4 text-right">
                  <Button size="sm" variant="outline" onClick={() => setEditing(workflowId)}>
                    Edit
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive ml-1 size-8"
                    onClick={() => mutate((file) => { delete file.repositories[id]!.workflows[workflowId]; })}
                  >
                    <F7Icon name="xmark" />
                    <span className="sr-only">Remove Workflow</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {Object.keys(repository.workflows).length === 0 && (
              <TableRow>
                <TableCell className="text-muted-foreground p-6 text-center">
                  No workflows — sessions start only from mentions and assignments.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const workflowId = `wf-${randomHex(4)}`;
            mutate((file) => {
              file.repositories[id]!.workflows[workflowId] = {
                on: "issue.state-changed",
                when: [{ "issue.state": ["Planning"] }],
                skill: { skillset: "", flags: [] },
                deliver: "start-session",
              };
            });
            setEditing(workflowId);
          }}
        >
          <F7Icon name="plus" />
          Add Workflow
        </Button>
      </div>
      {editing && repository.workflows[editing] && (
        <WorkflowEditor
          repositoryId={id}
          workflowId={editing}
          value={value}
          mutate={mutate}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function WorkflowEditor({
  repositoryId,
  workflowId,
  value,
  mutate,
  onClose,
}: {
  repositoryId: string;
  workflowId: string;
  value: ServiceFile;
  mutate: Mutate;
  onClose(): void;
}) {
  const repository = value.repositories[repositoryId]!;
  const workflow = repository.workflows[workflowId]!;
  const { data: scan } = useQuery(skillsQueryOptions(repository.root, repository.skillsRoot));
  const skillsets = scan?.installed ? scan.skillsets : [];
  const selected = skillsets.find((entry) => entry.id === workflow.skill.skillset);
  const conditionField = EVENT_CONDITION_FIELD[workflow.on];
  const conditionValues = (workflow.when ?? []).flatMap((condition) => condition[conditionField] ?? []);
  const edit = (change: (workflow: Workflow) => void) =>
    mutate((file) => { change(file.repositories[repositoryId]!.workflows[workflowId]!); });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Workflow: {workflowId}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Connection</Label>
            <Select
              value={workflow.connectionId ?? "any"}
              onValueChange={(next) => edit((entry) => { entry.connectionId = next === "any" ? undefined : next; })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any connection</SelectItem>
                {Object.entries(value.connections).map(([connectionId, connection]) => (
                  <SelectItem key={connectionId} value={connectionId}>{connection.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Event</Label>
            <Select
              value={workflow.on}
              onValueChange={(next) => edit((entry) => {
                entry.on = next as Workflow["on"];
                entry.when = undefined;
              })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(EVENT_LABELS).map(([event, label]) => (
                  <SelectItem key={event} value={event}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>{workflow.on === "issue.state-changed" ? "States" : "Reactions"}</Label>
            <Input
              value={conditionValues.join(", ")}
              placeholder={workflow.on === "issue.state-changed" ? "Planning, In Progress" : "pencil2"}
              onChange={(event) => edit((entry) => {
                const values = event.target.value.split(",").map((part) => part.trim()).filter(Boolean);
                entry.when = values.length > 0 ? [{ [conditionField]: values }] : undefined;
              })}
            />
            <p className="text-muted-foreground text-xs">
              Comma-separated; any listed value triggers. Leave empty to always trigger. Richer
              conditions are editable in the JSON.
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Skillset</Label>
            <Select
              value={workflow.skill.skillset || undefined}
              onValueChange={(next) => edit((entry) => { entry.skill = { skillset: next, flags: [] }; })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={skillsets.length === 0 ? "No skillsets found" : "Select a skillset"} />
              </SelectTrigger>
              <SelectContent>
                {skillsets.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>{entry.id}</SelectItem>
                ))}
                {workflow.skill.skillset && !selected && (
                  <SelectItem value={workflow.skill.skillset}>{workflow.skill.skillset} (missing)</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {selected && selected.flags.length > 0 && (
            <div className="grid gap-2">
              <Label>Flags</Label>
              <div className="grid grid-cols-2 gap-2">
                {selected.flags.map((flag) => (
                  <label key={flag.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={workflow.skill.flags.includes(flag.id)}
                      onCheckedChange={(next) => edit((entry) => {
                        const flags = new Set(entry.skill.flags);
                        if (next === true) flags.add(flag.id);
                        else flags.delete(flag.id);
                        entry.skill.flags = [...flags].sort();
                      })}
                    />
                    <span className="truncate font-mono text-xs">{flag.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <Label>Delivery</Label>
            <Select
              value={workflow.deliver}
              onValueChange={(next) => edit((entry) => { entry.deliver = next as Workflow["deliver"]; })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="start-session">Start a session in a new worktree</SelectItem>
                <SelectItem value="message-session">Message the issue's running session</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
