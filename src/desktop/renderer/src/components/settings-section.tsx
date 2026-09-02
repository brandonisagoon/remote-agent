import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@renderer/components/ui/accordion.tsx";
import { cn } from "@renderer/lib/utils.ts";

/** One settings group: accordion item with an optional instructional line. */
export function SettingsSection(props: {
  value: string;
  title: string;
  /** Anchor for hash links (e.g. /#webhooks). */
  id?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem value={props.value} id={props.id} className="scroll-mt-16">
      <AccordionTrigger className="text-base">{props.title}</AccordionTrigger>
      <AccordionContent className="grid gap-4 pt-1 pb-6">
        {props.description && <p className="text-muted-foreground -mt-2 text-sm">{props.description}</p>}
        {props.children}
      </AccordionContent>
    </AccordionItem>
  );
}

/** Tinted well holding a group of fields, bleeding into the page gutter so
    the fields align with the section titles. */
export function SettingsCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "bg-secondary/50 -mx-4 grid gap-4 rounded-lg p-4",
        "[&_[data-slot=input]]:bg-background [&_[data-slot=input-group]]:bg-background [&_[data-slot=select-trigger]]:bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}
