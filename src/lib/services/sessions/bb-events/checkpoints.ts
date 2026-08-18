import type { BbEvent } from "../../../../types/runtime/index.ts";

const MAX_CHECKPOINT_OUTPUT_CHARS = 8_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function buildBbCheckpointComment(
  event: BbEvent,
  output: string | null,
): string | null {
  const data = record(event.data);
  if (event.type === "turn/completed") {
    if (data?.status === "completed" && output?.trim()) {
      const trimmed = output.trim();
      const checkpoint =
        trimmed.length > MAX_CHECKPOINT_OUTPUT_CHARS
          ? `…${trimmed.slice(-MAX_CHECKPOINT_OUTPUT_CHARS)}`
          : trimmed;
      return ["### Agent checkpoint", "", checkpoint].join("\n");
    }
  }
  if (
    event.type === "system/userQuestion/lifecycle" &&
    data?.status === "pending"
  ) {
    const payload = record(data.payload);
    const questions = Array.isArray(payload?.questions)
      ? payload.questions
      : [];
    const rendered = questions.flatMap((questionValue) => {
      const question = record(questionValue);
      if (!question || typeof question.prompt !== "string") return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((optionValue) => {
            const option = record(optionValue);
            return typeof option?.label === "string"
              ? [
                  `- **${option.label}**${typeof option.description === "string" ? ` — ${option.description}` : ""}`,
                ]
              : [];
          })
        : [];
      return [question.prompt, ...options, ""];
    });
    if (rendered.length) {
      return [
        "Claude is waiting for your answer.",
        "",
        ...rendered,
        "Reply in this thread with `@agent` followed by your answer.",
      ].join("\n");
    }
  }
  return null;
}
