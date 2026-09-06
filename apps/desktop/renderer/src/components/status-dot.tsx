import { cn } from "@renderer/lib/utils.ts";

const STATUS_DOT = {
  ok: { color: "bg-emerald-600/60 dark:bg-emerald-400/50", label: "OK" },
  warn: { color: "bg-amber-600/60 dark:bg-amber-400/50", label: "Attention" },
  fail: { color: "bg-red-600/60 dark:bg-red-400/50", label: "Missing" },
} as const;

export function StatusDot({ status, label }: { status: "ok" | "warn" | "fail"; label?: string }) {
  const entry = STATUS_DOT[status];
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-2 shrink-0 rounded-full", entry.color)} />
      <span className="text-muted-foreground/70 text-xs">{label ?? entry.label}</span>
    </span>
  );
}
