import { z } from "zod";

/** Linear's Comment schema defines editedAt as the last author edit (null
 * before any edit). updatedAt also advances for non-edit entity updates. */
export const LinearCommentGeneration = z.object({
  version: z.literal(1), kind: z.literal("linear-author-edit"),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), editedAt: z.iso.datetime().nullable(),
}).strict();
type Generation = z.infer<typeof LinearCommentGeneration>;

export function observeLinearCommentGeneration(comment: { createdAt?: string; updatedAt?: string; editedAt?: string | null }): Generation {
  // Missing is unknown, never proof of no edit.
  const parsed = LinearCommentGeneration.safeParse({ version: 1, kind: "linear-author-edit", createdAt: comment.createdAt, updatedAt: comment.updatedAt, editedAt: comment.editedAt });
  if (!parsed.success || [parsed.data.createdAt, parsed.data.updatedAt, parsed.data.editedAt].some(value => value !== null && Date.parse(value) > Date.now())) throw new Error("Comment author-edit generation is unavailable");
  if (parsed.data.editedAt !== null && (Date.parse(parsed.data.editedAt) < Date.parse(parsed.data.createdAt) || Date.parse(parsed.data.editedAt) > Date.parse(parsed.data.updatedAt))) throw new Error("Comment author-edit generation is unavailable");
  return parsed.data;
}

export function classifyLinearCommentGeneration(saved: Generation, current: Generation, samePublication: boolean) {
  if (current.createdAt !== saved.createdAt || Date.parse(current.updatedAt) < Date.parse(saved.updatedAt)) throw new Error("Comment is not a later generation of the attested publication");
  const sameEdit = current.editedAt === saved.editedAt;
  if (sameEdit && !samePublication) throw new Error("Comment is not a later generation of the attested publication");
  if (!sameEdit && (current.editedAt === null || Date.parse(current.editedAt) <= Date.parse(saved.editedAt ?? saved.createdAt) || Date.parse(current.editedAt) > Date.parse(current.updatedAt))) throw new Error("Comment is not a later generation of the attested publication");
  return { informational: sameEdit, revision: `${current.createdAt}:author-edit:${current.editedAt ?? "none"}` };
}
