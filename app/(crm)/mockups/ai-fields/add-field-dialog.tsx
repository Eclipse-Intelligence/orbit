"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Radio } from "@/components/_ui/radio";
import { Textarea } from "@/components/_ui/textarea";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import type { FieldType } from "./mock-data";

const TYPES: { value: FieldType; label: string; hint: string }[] = [
  { value: "yesno", label: "Yes or no", hint: "Yes, No or Unknown" },
  { value: "number", label: "Number", hint: "Such as staff" },
  { value: "text", label: "Short text", hint: "A few words" },
  { value: "pick", label: "Pick from list", hint: "One of your options" },
];

const REFRESH = ["Monthly", "Weekly", "Only when I ask"];

const PLANS = {
  pick: {
    question: "Which type of agency is this? SEO means search is most of what they sell.",
    column: "Agency type",
    scope: "fit",
    cost: "About 61 web checks to fill it, $0.06, then about $0.06 a month.",
    note: "Yes or no and pick from list questions about the same company share one check, so more of them cost no more.",
  },
  number: {
    question: "How many people work at this agency? Count staff, not freelancers.",
    column: "Staff",
    scope: "all",
    cost: "About 214 web checks to fill it, $2.14, then about $2.14 a month.",
    note: "Numbers and short text need a longer check, $0.01 a company. Other number and short text fields share it.",
  },
};

export default function AddFieldDialog({ type }: { type: "pick" | "number" }) {
  const plan = PLANS[type];
  const question = useId();
  const column = useId();
  const scope = useId();
  const many = useId();
  return (
    <Dialog open>
      <DialogContent className="max-w-[560px]" onInteractOutside={(event) => event.preventDefault()} onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add AI field</DialogTitle>
          <DialogDescription>Answered for each company from the web, with sources.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 px-6 py-5">
          <Field label="Question" htmlFor={question}>
            <Textarea id={question} rows={2} defaultValue={plan.question} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="caption-style text-subtle mb-2">Answer</legend>
            <div className="grid grid-cols-2 gap-2">
              {TYPES.map((item) => (
                <label
                  key={item.value}
                  className={cn(
                    "border-border flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
                    item.value === type && "border-line-strong bg-white/[0.04]",
                  )}
                >
                  <Radio name="answer" defaultChecked={item.value === type} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="ui-style text-foreground">{item.label}</span>
                    <span className="caption-style text-subtle">{item.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {type === "pick" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="caption-style text-subtle mb-2">Options</legend>
              {["SEO", "PR", "Content", "Other"].map((option, index) => (
                <div key={option} className="flex items-center gap-2">
                  <label htmlFor={`${scope}-option-${index}`} className="sr-only">
                    Option {index + 1}
                  </label>
                  <Input id={`${scope}-option-${index}`} defaultValue={option} />
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${option}`}>
                    <XIcon aria-hidden className="size-3.5" />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={many} className="caption-style text-soft flex items-center gap-2">
                  <Checkbox id={many} />
                  Allow more than one
                </label>
                <Button variant="ghost" size="sm">
                  <PlusIcon aria-hidden className="size-3" />
                  Add option
                </Button>
              </div>
            </fieldset>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Column name" htmlFor={column}>
              <Input id={column} maxLength={20} defaultValue={plan.column} />
            </Field>
            <Field label="Companies" htmlFor={scope}>
              <NativeSelect id={scope} defaultValue={plan.scope}>
                <option value="all">All with a website (214)</option>
                <option value="fit">Fit Good or better (61)</option>
                <option value="geo">View: GEO prospects (10)</option>
                <option value="customers">View: Customers (12)</option>
              </NativeSelect>
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="caption-style text-subtle mb-2">Refresh</legend>
            <span role="radiogroup" aria-label="Refresh" className="flex w-fit items-center rounded-full bg-white/[0.04] p-0.5">
              {REFRESH.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={option === "Monthly"}
                  className={cn(
                    "caption-style cursor-pointer rounded-full px-3 py-1.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    option === "Monthly" ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
                  )}
                >
                  {option}
                </button>
              ))}
            </span>
            <span className="caption-style text-subtle">New companies are checked when they&apos;re added.</span>
          </fieldset>
          <div className="flex flex-col gap-1 rounded-lg bg-white/[0.04] px-3 py-2.5">
            <span className="ui-style text-foreground">{plan.cost}</span>
            <span className="caption-style text-subtle">{plan.note}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Save and fill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
