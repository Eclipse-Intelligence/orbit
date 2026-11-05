"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Radio } from "@/components/_ui/radio";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { createWorkspaceAction } from "@/app/(crm)/workspaces";
import { cn } from "@/lib/utils";

type BrandStart = "blank" | "copy";

function StartOption({
  value,
  checked,
  onSelect,
  icon,
  title,
  children,
}: {
  value: BrandStart;
  checked: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const id = `workspace-start-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "ease-power3-out flex cursor-pointer items-start gap-3 rounded-xl p-3 transition-colors duration-150",
        checked ? "bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "hover:bg-white/[0.03]",
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground text-[13.5px] leading-5 font-medium">{title}</span>
        <span id={`${id}-hint`} className="caption-style text-subtle">
          {children}
        </span>
      </span>
      <Radio
        id={id}
        name="workspace-start"
        value={value}
        checked={checked}
        onChange={onSelect}
        aria-describedby={`${id}-hint`}
        className="mt-2"
      />
    </label>
  );
}

export default function NewWorkspaceDialog({
  open,
  onOpenChange,
  currentId,
  currentName,
  defaultName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentId: string;
  currentName: string;
  defaultName: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [start, setStart] = useState<BrandStart>("blank");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await createWorkspaceAction({ name, brandStart: start });
    if (result.error || !result.id) {
      setPending(false);
      setError(result.error ?? "Couldn't create the workspace.");
      return;
    }
    onCreated();
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
            <DialogDescription>Its own records, team and brand. Your mail and calendar stay the same.</DialogDescription>
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
            <fieldset className="flex flex-col gap-2">
              <legend className="caption-style text-soft mb-2">Start the brand profile from</legend>
              <StartOption
                value="blank"
                checked={start === "blank"}
                onSelect={() => setStart("blank")}
                title="Blank"
                icon={<span aria-hidden className="size-8 shrink-0 rounded-lg border border-dashed border-white/15" />}
              >
                Fill it in under Settings › Brand.
              </StartOption>
              <StartOption
                value="copy"
                checked={start === "copy"}
                onSelect={() => setStart("copy")}
                title={`Copy from ${currentName}`}
                icon={<WorkspaceTile id={currentId} name={currentName} className="size-8 rounded-lg text-[13px]" />}
              >
                What you sell, who it&apos;s for, tone and the cold email playbook. Proof and Knowledge start empty.
              </StartOption>
            </fieldset>
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
