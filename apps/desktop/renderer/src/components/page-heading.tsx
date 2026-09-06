import { Badge } from "@renderer/components/ui/badge.tsx";

export function PageHeading({ title, description, badge }: { title: string; description: string; badge?: string }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}
