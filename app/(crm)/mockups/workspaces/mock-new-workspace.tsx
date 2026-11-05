"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Radio } from "@/components/_ui/radio";
import { cn } from "@/lib/utils";
import { WORKSPACES } from "./mock-data";
import { WorkspaceTile } from "./mock-shell";

function StartOption({ checked, onSelect, icon, title, children }: { checked: boolean; onSelect: () => void; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <label
      className={cn(
        "ease-power3-out flex cursor-pointer items-start gap-3 rounded-xl p-3 transition-colors duration-150",
        checked ? "bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "hover:bg-white/[0.03]",
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground text-[13.5px] leading-5 font-medium">{title}</span>
        <span className="caption-style text-subtle">{children}</span>
      </span>
      <Radio name="brand-start" checked={checked} onChange={onSelect} className="mt-2" aria-label={title} />
    </label>
  );
}

export function NewWorkspaceDialog() {
  const [start, setStart] = useState<"blank" | "eclipse">("blank");
  return (
    <Dialog open>
      <DialogContent className="max-w-[440px]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <DialogHeader className="pr-12">
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>Its own records, team and brand. Your mail and calendar stay the same.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5 px-6 py-5">
            <Field label="Name" htmlFor="workspace-name">
              <Input id="workspace-name" defaultValue="Mark Ridgeon" autoComplete="off" />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="caption-style text-soft mb-2">Start the brand profile from</legend>
              <StartOption
                checked={start === "blank"}
                onSelect={() => setStart("blank")}
                title="Blank"
                icon={<span aria-hidden className="size-8 shrink-0 rounded-lg border border-dashed border-white/15" />}
              >
                Fill it in under Settings › Brand.
              </StartOption>
              <StartOption
                checked={start === "eclipse"}
                onSelect={() => setStart("eclipse")}
                title="Copy from Eclipse"
                icon={<WorkspaceTile workspace={WORKSPACES.eclipse} className="size-8 rounded-lg text-[13px]" />}
              >
                What you sell, who it&apos;s for, tone and the cold email playbook. Proof and Knowledge start empty.
              </StartOption>
            </fieldset>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" size="md" type="submit">
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
