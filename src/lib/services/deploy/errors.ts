export class DeployScriptMissingError extends Error {
  constructor(public readonly scriptPath: string) {
    super(`Deploy script not found: ${scriptPath}`);
    this.name = "DeployScriptMissingError";
  }
}
