import { useState } from "react";

import { Button } from "@renderer/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog.tsx";
import { Input } from "@renderer/components/ui/input.tsx";
import { Label } from "@renderer/components/ui/label.tsx";

export function AddRepositoryDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  existingIds: string[];
  onCreate(id: string): void;
}) {
  const [id, setId] = useState("");
  const trimmed = id.trim();
  const invalid = !trimmed || props.existingIds.includes(trimmed);
  const submit = () => {
    if (invalid) return;
    props.onCreate(trimmed);
    props.onOpenChange(false);
    setId("");
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>The ID is a stable JSON key; paths default from it and can be edited after.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>Repository ID</Label>
          <Input
            value={id}
            placeholder="repository-1"
            onChange={(event) => setId(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
          {trimmed && props.existingIds.includes(trimmed) && (
            <p className="text-destructive text-xs">A repository with this ID already exists.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={invalid} onClick={submit}>
            Add Repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
