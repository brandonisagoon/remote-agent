/** A user-session daemon registration. Both platforms run the daemon in the
    user's login context (not a system service) because acpx provider
    processes need the user's credentials. */
export interface ServiceDefinition {
  /** Stable identifier: launchd label / Task Scheduler task name. */
  label: string;
  /** Absolute-path argv the supervisor execs. */
  command: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  /** stdout+stderr destination (best effort on platforms that support it). */
  logFile: string;
}

export interface Supervisor {
  /** Register with the platform supervisor (start at login, restart on
      failure) and start now. Idempotent. */
  install(definition: ServiceDefinition): Promise<void>;
  uninstall(label: string): Promise<void>;
  /** Stop without unregistering; a stopped service still starts at login. */
  stop(label: string): Promise<void>;
  /** Re-register if needed, then force a fresh process. */
  restart(definition: ServiceDefinition): Promise<void>;
  /** Whether the label is registered with the platform supervisor. */
  registered(label: string): Promise<boolean>;
}
