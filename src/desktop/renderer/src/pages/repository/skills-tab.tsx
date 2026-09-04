import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import { SettingsSection } from "@renderer/components/settings-section.tsx";
import { StatusDot } from "@renderer/components/status-dot.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { skillsQueryOptions } from "@renderer/lib/queries/skills.ts";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

const INSTALL_CLI_COMMAND = "bun add --dev github:brandonisagoon/skill-composer";
/** `init` scaffolds agent-skills/, the config, and a first skillset. */
const INIT_COMMAND = "bunx skill-composer init my-first-skill";
const GITIGNORE_COMMAND =
  "printf '\\n# generated skills (skill-composer)\\n/.claude/skills/skill-composer-*/\\n/.agents/skills/skill-composer-*/\\n' >> .gitignore";

/** Read-only view of the repository's skill-composer skillsets. Skills are
    files in the user's repo — authored in their editor, never here. */
export function SkillsTab({ id, value, mutate }: { id: string; value: ServiceFile; mutate: Mutate }) {
  const repository = value.repositories[id]!;
  const skillsRoot = repository.skillsRoot;
  const queryClient = useQueryClient();
  const options = skillsQueryOptions(repository.root, skillsRoot);
  const { data: scan, isFetching, error } = useQuery({
    ...options,
    // The install/create/ignore steps happen in Terminal, invisible to the
    // app; poll while any of them is outstanding, stop once all are green.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return data.installed && data.configFound && data.gitignored ? false : 2_000;
    },
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: options.queryKey });
  const skillsDirectory = `${repository.root.replace(/\/$/, "")}/${skillsRoot}`;

  // Same dumb-install pattern as the machine page: the button opens Terminal
  // with the command prefilled; nothing privileged runs from the app.
  const changeSkillsRoot = async () => {
    const picked = await window.remoteAgent.skills.pickRoot(skillsDirectory);
    if (!picked) return;
    const root = repository.root.replace(/\/$/, "");
    if (picked !== root && !picked.startsWith(`${root}/`)) {
      toast.error("The skills root must be inside the repository");
      return;
    }
    const relative = picked === root ? "." : picked.slice(root.length + 1);
    mutate((file) => { file.repositories[id]!.skillsRoot = relative; });
  };

  const openTerminal = async (command: string) => {
    const result = await window.remoteAgent.management.openTerminal(
      `cd '${repository.root}' && ${command}`,
    );
    if (!result.ok) toast.error(result.summary);
  };

  return (
    <Accordion type="multiple" defaultValue={["installation", "skillsets"]} className="-mt-4">
      <SettingsSection
        value="installation"
        title="Installation"
        description="skill-composer builds each skill from plain files in this repository: an introduction, snippets of instructions, and optional flags that splice in extra behavior. When a workflow fires, remote-agent runs the CLI inside the session's fresh worktree to compose the selected skillset and flags into a skill the agent invokes. The CLI is this repository's own dev dependency."
      >
        <div className="bg-background -mx-4 rounded-lg border">
          <Table className="table-fixed">
            <TableBody>
              <TableRow className="h-14">
                <TableCell className="pl-4">
                  <div>skill-composer CLI</div>
                  {!scan?.installed && (
                    <div className="text-muted-foreground truncate font-mono text-xs">{INSTALL_CLI_COMMAND}</div>
                  )}
                </TableCell>
                <TableCell className="w-28">
                  <StatusDot status={scan?.installed ? "ok" : "fail"} label={scan?.installed ? "Installed" : "Missing"} />
                </TableCell>
                <TableCell className="w-48 pr-4 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!scan || scan.installed}
                    onClick={() => void openTerminal(INSTALL_CLI_COMMAND)}
                  >
                    Install
                  </Button>
                </TableCell>
              </TableRow>
              <TableRow className="h-14">
                <TableCell className="pl-4">
                  <div>Skills Directory</div>
                  <div className="text-muted-foreground truncate font-mono text-xs">
                    {skillsRoot}/skill-composer.config.ts
                  </div>
                </TableCell>
                <TableCell className="w-28">
                  <StatusDot status={scan?.configFound ? "ok" : "fail"} label={scan?.configFound ? "Found" : "Missing"} />
                </TableCell>
                <TableCell className="w-48 pr-4 text-right">
                  {scan?.configFound ? (
                    <Button size="sm" variant="outline" onClick={() => void changeSkillsRoot()}>
                      Change
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!scan?.installed}
                      onClick={() => void openTerminal(INIT_COMMAND)}
                    >
                      Create
                    </Button>
                  )}
                </TableCell>
              </TableRow>
              <TableRow className="h-14">
                <TableCell className="pl-4">
                  <div>Generated Output Ignored</div>
                </TableCell>
                <TableCell className="w-28">
                  <StatusDot status={scan?.gitignored ? "ok" : "warn"} label={scan?.gitignored ? "Ignored" : "Attention"} />
                </TableCell>
                <TableCell className="w-48 pr-4 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!scan || scan.gitignored}
                    onClick={() => void openTerminal(GITIGNORE_COMMAND)}
                  >
                    Add
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <SettingsSection
        value="skillsets"
        title="Skillsets"
        description="Instruction sets authored in this repository. A workflow selects one and composes it into the session it launches."
      >
        <div className="-mx-4 -mb-2 flex justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" onClick={refresh}>
                <F7Icon name="arrow_2_circlepath" className={cn("size-3.5", isFetching && "animate-spin")} />
                <span className="sr-only">Refresh Skillsets</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
        {error && (
          <div className="bg-background -mx-4 rounded-lg border p-3 text-sm">
            <span className="text-destructive font-medium">Scan failed:</span>{" "}
            <span className="text-muted-foreground">{error instanceof Error ? error.message : String(error)}</span>
          </div>
        )}
        {scan && scan.problems.length > 0 && (
          <div className="bg-background -mx-4 rounded-lg border p-3 text-sm">
            <span className="text-destructive font-medium">check reported problems</span>
            <pre className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{scan.problems.join("\n")}</pre>
          </div>
        )}
        <div className="bg-background -mx-4 rounded-lg border">
          <Table className="table-fixed">
            <TableBody>
              {(scan?.skillsets ?? []).map((skillset) => (
                <Tooltip key={skillset.id}>
                  <TooltipTrigger asChild>
                <TableRow className="h-14">
                  <TableCell className="pl-4">
                    <div>{skillset.id}</div>
                    <div className="text-muted-foreground truncate text-xs">
                      {skillset.snippets.length} snippet{skillset.snippets.length === 1 ? "" : "s"}
                      {skillset.flags.length > 0 && ` · flags: ${skillset.flags.map((flag) => flag.id).join(", ")}`}
                      {skillset.hooks.length > 0 && ` · ${skillset.hooks.length} hook${skillset.hooks.length === 1 ? "" : "s"}`}
                    </div>
                  </TableCell>
                  <TableCell className="w-28">
                    <span className="text-muted-foreground/70 text-xs">{skillset.harnesses.join(" · ")}</span>
                  </TableCell>
                  <TableCell className="w-48 pr-4 text-right">
                    <OpenInEditorMenu target={`${skillsDirectory}/${skillset.id}`} />
                  </TableCell>
                </TableRow>
                  </TooltipTrigger>
                  {skillset.description && (
                    <TooltipContent side="bottom" className="max-w-80">{skillset.description}</TooltipContent>
                  )}
                </Tooltip>
              ))}
              {(scan?.skillsets ?? []).length === 0 && (
                <TableRow>
                  <TableCell className="text-muted-foreground p-6 text-center">
                    {scan ? `No skillsets found under ${skillsRoot}/.` : "Scanning…"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>
    </Accordion>
  );
}
