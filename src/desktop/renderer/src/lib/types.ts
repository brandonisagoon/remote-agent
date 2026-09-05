import type { ServiceFile } from "../../../../lib/config.ts";

/** Applies a draft edit against the working copy of the config file. */
export type Mutate = (change: (value: ServiceFile) => void) => void;
