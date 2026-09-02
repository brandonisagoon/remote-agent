import { siGithub, siLinear } from "simple-icons";

import { cn } from "@renderer/lib/utils.ts";

const BRANDS = {
  github: siGithub,
  linear: siLinear,
} as const;

export type BrandIconName = keyof typeof BRANDS;

/** Brand logos from simple-icons, sized/colored like the F7 icons. */
export function BrandIcon({ name, className }: { name: BrandIconName; className?: string }) {
  const icon = BRANDS[name];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 shrink-0", className)}
    >
      <path d={icon.path} />
    </svg>
  );
}
