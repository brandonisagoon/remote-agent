import { z } from "zod";
import { MachineSchema } from "./machines/registry.ts";

const PrivateEndpoint = z.string().url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
}, "Use HTTPS or a loopback SSH forward, without path, query, or credentials");

export const RoutingConfigSchema = z.object({
  ingress: z.boolean().default(false),
  receiverOnly: z.boolean().default(false),
  peers: z.record(MachineSchema, z.object({
    url: PrivateEndpoint,
    apiKey: z.string().min(16),
    repositories: z.array(z.string().min(1)).min(1),
  })).default({}),
  connectionHosts: z.record(z.string().min(1), MachineSchema).default({}),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
