import { z } from "zod";

const publicUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}, "Use a public HTTPS app preview");

export const ChatgptReviewSchema = z.object({
  taskId: z.string().min(1),
  url: publicUrl,
  skill: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
});

const ReviewTasksSchema = z.object({ tasks: z.array(z.object({
  id: z.string(), repositoryId: z.string(), machineId: z.string(), primarySessionId: z.string().nullable(),
  resources: z.array(z.object({
    kind: z.string(), purpose: z.string(), state: z.string(), metadata: z.unknown().optional(),
  })),
})) });
const PreviewMetadataSchema = z.object({ publicUrl, chatgptSkill: ChatgptReviewSchema.shape.skill });
type SessionIdentity = { id: string; machineId: string; repositoryId: string };

/** A preview belongs to one exact primary session, never a similarly named
 * checkout, another host, or the task's streamed browser/control endpoint. */
export function chatgptReviewForSession(session: SessionIdentity, rawTasks: unknown) {
  const result = ReviewTasksSchema.safeParse(rawTasks);
  if (!result.success) return undefined;
  const task = result.data.tasks.find((entry) => entry.primarySessionId === session.id && entry.machineId === session.machineId && entry.repositoryId === session.repositoryId);
  if (!task) return undefined;
  for (const resource of task.resources) {
    if (resource.kind !== "local-http" || !["development", "review"].includes(resource.purpose) || !["ready", "allocated"].includes(resource.state)) continue;
    const metadata = PreviewMetadataSchema.safeParse(resource.metadata);
    if (metadata.success) return { taskId: task.id, url: metadata.data.publicUrl, skill: metadata.data.chatgptSkill };
  }
  return undefined;
}

export function chatgptReviewLink(session: SessionIdentity, review: z.infer<typeof ChatgptReviewSchema>, repositoryOrigin: string | null) {
  const context = ChatgptReviewSchema.parse(review);
  const prompt = `Use $${context.skill} to open this app preview in the ChatGPT browser and help me review it. Route my feedback to this existing remote session.\n\n${JSON.stringify({ taskId: context.taskId, sessionId: session.id, machineId: session.machineId, repositoryId: session.repositoryId, previewUrl: context.url }, null, 2)}`;
  // Match the client's workspace by the credential-free Git identity. A remote
  // session's cwd/worktreePath belongs to its host, not the client opening ChatGPT.
  const repository = repositoryOrigin ? `&originUrl=${encodeURIComponent(`https://${repositoryOrigin}`)}` : "";
  return `codex://new?prompt=${encodeURIComponent(prompt)}${repository}&browserUrl=${encodeURIComponent(context.url)}`;
}
