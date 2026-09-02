import { Input } from "@renderer/components/ui/input.tsx";
import { Label } from "@renderer/components/ui/label.tsx";

export function Field(props: {
  label: string;
  value: string | number;
  type?: string;
  disabled?: boolean;
  description?: string;
  onChange(value: string): void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <Input
        type={props.type}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.description && <p className="text-muted-foreground text-xs">{props.description}</p>}
    </div>
  );
}
