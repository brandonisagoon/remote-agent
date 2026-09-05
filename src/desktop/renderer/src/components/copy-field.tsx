import { toast } from "sonner";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";

/** Read-only derived value with an inline copy button. */
export function CopyField(props: {
  label: string;
  value: string;
  /** Extra inline buttons rendered before the copy button. */
  action?: React.ReactNode;
  description?: React.ReactNode;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(props.value);
    toast.success(`${props.label} copied`);
  };
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <InputGroup>
        <InputGroupInput value={props.value} readOnly className="text-muted-foreground font-mono" />
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton size="icon-xs" onClick={() => void copy()}>
                <F7Icon name="doc_on_doc" />
                <span className="sr-only">Copy {props.label}</span>
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
          {props.action}
        </InputGroupAddon>
      </InputGroup>
      {props.description && <p className="text-muted-foreground text-xs">{props.description}</p>}
    </div>
  );
}
