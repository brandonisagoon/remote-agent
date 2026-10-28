import { CommandError, run } from "../run.ts";

/** launchctl bootout acknowledges removal before the job has necessarily left
 * its domain. Do not bootstrap its replacement until removal is observable. */
export async function stopLaunchdJob(
  service: string,
  dependencies: { run?: typeof run; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<void> {
  const execute = dependencies.run ?? run;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const stopped = await execute("launchctl", ["bootout", service]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const observed = await execute("launchctl", ["print", service]);
    if (!observed.ok) {
      if (/Could not find service\b/i.test(observed.output)) return;
      throw new CommandError("launchctl", ["print", service], observed);
    }
    if (!stopped.ok) throw new CommandError("launchctl", ["bootout", service], stopped);
    if (attempt < 39) await sleep(250);
  }
  throw new Error(`launchctl bootout: ${service} remained registered after the bounded removal wait`);
}
