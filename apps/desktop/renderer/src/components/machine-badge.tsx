import { Badge } from "./ui/badge.tsx";

export function MachineBadge({ name, unavailable }: { name: string; unavailable?: boolean }) {
  return <Badge variant="secondary" className="ml-auto max-w-[55%] shrink-0 truncate px-1.5 py-0 text-[10px] font-normal" title={unavailable ? `${name} · Last received configuration; reconnect to refresh` : name}>
    {name}{unavailable && <span aria-label="Unavailable"> · !</span>}
  </Badge>;
}
