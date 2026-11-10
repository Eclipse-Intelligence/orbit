"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { createWorkspaceAction } from "@/app/(crm)/workspaces";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";

export default function NewWorkspaceDialog({
  open,
  onOpenChange,
  defaultName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await createWorkspaceAction({ name });
      if (result.error || !result.id) {
        setPending(false);
        setError(result.error ?? "Couldn't create the workspace.");
        return;
      }
      onCreated();
    } catch (problem) {
      setPending(false);
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't create the workspace. Try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[440px]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader className="pr-12">
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>Starts blank. Your mail and calendar stay the same.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5 px-6 py-5">
            <Field label="Name" htmlFor="workspace-name" error={error ?? undefined}>
              <Input
                id="workspace-name"
                value={name}
                required
                maxLength={120}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "workspace-name-error" : undefined}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" size="md" type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
