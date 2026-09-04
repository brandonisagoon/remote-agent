import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { skillsQueryOptions } from "@renderer/lib/queries/skills.ts";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

/** Read-only view of the repository's skill-composer skillsets. Skills are
    files in the user's repo — authored in their editor, never here. */
export function SkillsTab({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const skillsRoot = repository.skillsRoot;
  const queryClient = useQueryClient();
  const options = skillsQueryOptions(repository.root, skillsRoot);
  const { data: scan, isFetching } = useQuery(options);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: options.queryKey });
  const skillsDirectory = `${repository.root.replace(/\/$/, "")}/${skillsRoot}`;

  return (
    <div className="grid gap-4">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label="Skills Root"
            description="Where the skill-composer inputs live, relative to the repository root."
            value={skillsRoot}
            onChange={(next) => mutate((file) => { file.repositories[id]!.skillsRoot = next || "agent-skills"; })}
          />
        </div>
        <Button variant="outline" size="sm" className="mb-9" onClick={() => void window.remoteAgent.shell.openPath(skillsDirectory)}>
          <F7Icon name="folder" />
          Open Folder
        </Button>
        <Button variant="outline" size="sm" className="mb-9" onClick={refresh}>
          <F7Icon name="arrow_2_circlepath" className={cn(isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!scan ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          Scanning…
        </div>
      ) : !scan.installed ? (
        <div className="rounded-md border border-dashed p-6 text-sm">
          <p className="font-medium">skill-composer is not installed in this repository.</p>
          <p className="text-muted-foreground mt-1">
            Add it as a dev dependency, then refresh:{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
              bun add --dev github:brandonisagoon/skill-composer
            </code>
          </p>
        </div>
      ) : (
        <>
          {scan.problems.length > 0 && (
            <div className="rounded-md border p-3 text-sm">
              <span className="text-destructive font-medium">check reported problems</span>
              <pre className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{scan.problems.join("\n")}</pre>
            </div>
          )}
          <div className="bg-background rounded-md border">
            <Table className="table-fixed">
              <TableBody>
                {scan.skillsets.map((skillset) => (
                  <TableRow key={skillset.id} className="h-14">
                    <TableCell className="pl-4">
                      <div className="font-mono text-sm">{skillset.id}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {skillset.snippets.length} snippet{skillset.snippets.length === 1 ? "" : "s"}
                        {skillset.flags.length > 0 && ` · flags: ${skillset.flags.map((flag) => flag.id).join(", ")}`}
                        {skillset.hooks.length > 0 && ` · ${skillset.hooks.length} hook${skillset.hooks.length === 1 ? "" : "s"}`}
                      </div>
                    </TableCell>
                    <TableCell className="w-32">
                      <span className="text-muted-foreground/70 text-xs">{skillset.harnesses.join(" · ")}</span>
                    </TableCell>
                    <TableCell className="w-32 pr-4 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void window.remoteAgent.shell.openPath(`${skillsDirectory}/${skillset.id}`)}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {scan.skillsets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground p-6 text-center">
                      No skillsets found under {skillsRoot}/.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
