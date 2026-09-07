import { useEffect, useState } from "react";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group.tsx";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useKeybindingLabel } from "@renderer/lib/keybindings.tsx";
import { secretsVisible, subscribeSecrets } from "@renderer/lib/secrets-visibility.ts";

/** Password-style field with an inline show/hide toggle. */
export function SecretField(props: {
  label: string;
  value: string;
  description?: string;
  onChange(value: string): void;
}) {
  const toggleLabel = useKeybindingLabel("toggle-secrets");
  const [visible, setVisible] = useState(secretsVisible);
  useEffect(() => subscribeSecrets(() => setVisible(secretsVisible())), []);
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <InputGroup>
        <InputGroupInput
          type={visible ? "text" : "password"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton size="icon-xs" onClick={() => setVisible((current) => !current)}>
                <F7Icon name={visible ? "eye_slash" : "eye"} />
                <span className="sr-only">{visible ? "Hide" : "Show"}</span>
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-1.5">
              {visible ? "Hide" : "Show"}
              <KbdGroup>
                {toggleLabel.split(" ").map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      {props.description && <p className="text-muted-foreground text-xs">{props.description}</p>}
    </div>
  );
}
