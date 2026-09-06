export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandClient {
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; stdin?: string; detached?: boolean },
  ) => Promise<CommandResult>;
}
