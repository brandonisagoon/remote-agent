import { Input } from "@renderer/components/ui/input.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import { cn } from "@renderer/lib/utils.ts";

export function Field(props: {
  label: string;
  value: string | number;
  type?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Extra classes for the input element (e.g. font-mono). */
  inputClassName?: string;
  description?: React.ReactNode;
  onChange(value: string): void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <Input
        type={props.type}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        className={cn(props.inputClassName)}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.description && <p className="text-muted-foreground text-xs">{props.description}</p>}
    </div>
  );
}
