"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Radio } from "@/components/_ui/radio";
import { Textarea } from "@/components/_ui/textarea";
import { aiFieldScopeCountsAction, saveAiFieldAction } from "@/app/(crm)/ai-fields";
import {
  AI_FIELD_LABEL_MAX,
  AI_FIELD_OPTION_MAX,
  AI_FIELD_OPTIONS_MAX,
  AI_FIELD_REFRESH,
  AI_FIELD_REFRESH_LABELS,
  costHint,
  looksLikeStaff,
  type AiField,
  type AiFieldKind,
  type AiFieldRefresh,
  type CompanyView,
} from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const TYPES: { value: AiFieldKind; label: string; hint: string }[] = [
  { value: "yes_no", label: "Yes or no", hint: "Yes, No or Unknown" },
  { value: "number", label: "Number", hint: "Such as staff" },
  { value: "text", label: "Short text", hint: "A few words" },
  { value: "pick", label: "Pick from list", hint: "One of your options" },
];

type Counts = { all: number; fit: number; views: Record<string, number> };

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  field?: AiField | null;
  views: CompanyView[];
  onSaved?: (field: AiField) => void;
};

type OptionRow = { key: number; value: string };

function scopeValue(field: AiField | null | undefined) {
  if (!field) return "all";
  if (field.scope === "view" && field.scopeViewId) return `view:${field.scopeViewId}`;
  return field.scope === "fit" ? "fit" : "all";
}

function FieldForm({ field, views, onDone, onCancel }: { field: AiField | null; views: CompanyView[]; onDone: (field: AiField) => void; onCancel: () => void }) {
  const ids = {
    question: useId(),
    label: useId(),
    scope: useId(),
    many: useId(),
    size: useId(),
    options: useId(),
  };
  const [question, setQuestion] = useState(field?.question ?? "");
  const [kind, setKind] = useState<AiFieldKind>(field?.kind ?? "yes_no");
  const [options, setOptions] = useState<OptionRow[]>(() =>
    (field?.options.length ? field.options : ["", ""]).map((value, index) => ({ key: index, value })),
  );
  const [nextKey, setNextKey] = useState(() => Math.max(2, field?.options.length ?? 0));
  const [multiple, setMultiple] = useState(field?.multiple ?? false);
  const [label, setLabel] = useState(field?.label ?? "");
  const [scope, setScope] = useState(() => scopeValue(field));
  const [refresh, setRefresh] = useState<AiFieldRefresh>(field?.refresh ?? "monthly");
  const [fillsSize, setFillsSize] = useState<boolean | null>(field ? field.fillsSize : null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  useEffect(() => {
    let live = true;
    void aiFieldScopeCountsAction().then((result) => {
      if (live && !("error" in result)) setCounts(result);
    });
    return () => {
      live = false;
    };
  }, []);

  const sizeTicked = fillsSize ?? looksLikeStaff(label, question);
  const scopeCount = !counts ? null : scope === "all" ? counts.all : scope === "fit" ? counts.fit : (counts.views[scope.slice(5)] ?? 0);
  const hint = scopeCount === null ? null : costHint(kind, scopeCount, refresh);
  const count = (value: number | undefined) => (value === undefined ? "" : ` (${value.toLocaleString("en-GB")})`);

  function updateOption(key: number, value: string) {
    setOptions((rows) => rows.map((row) => (row.key === key ? { ...row, value } : row)));
  }

  function addOption() {
    setOptions((rows) => [...rows, { key: nextKey, value: "" }]);
    setNextKey((key) => key + 1);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const viewId = scope.startsWith("view:") ? scope.slice(5) : null;
    const result = await saveAiFieldAction({
      id: field?.id,
      label,
      question,
      kind,
      options: kind === "pick" ? options.map((row) => row.value) : [],
      multiple: kind === "pick" && multiple,
      scope: viewId ? "view" : scope,
      scopeViewId: viewId,
      refresh,
      fillsSize: kind === "number" ? sizeTicked : false,
    });
    setSaving(false);
    if ("error" in result) {
      setError({ message: result.error, field: result.field });
      return;
    }
    onDone(result.field);
  }

  const fieldError = (name: string) => (error?.field === name ? error.message : undefined);
  const general = error && !["question", "label", "options", "scopeViewId", "kind"].includes(error.field ?? "") ? error.message : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{field ? "Edit AI field" : "Add AI field"}</DialogTitle>
        <DialogDescription>Answered for each company from the web, with sources.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <Field label="Question" htmlFor={ids.question} error={fieldError("question")}>
          <Textarea
            id={ids.question}
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Does this agency sell GEO or AI search work to its clients?"
            maxLength={1000}
            required
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle mb-2">Answer</legend>
          <div className="grid grid-cols-2 gap-2">
            {TYPES.map((item) => (
              <label
                key={item.value}
                className={cn(
                  "border-border flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-150 ease-power3-out",
                  item.value === kind && "border-line-strong bg-white/[0.04]",
                )}
              >
                <Radio name="answer" value={item.value} checked={item.value === kind} onChange={() => setKind(item.value)} className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="ui-style text-foreground">{item.label}</span>
                  <span className="caption-style text-subtle">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {fieldError("kind") && (
            <span role="alert" className="caption-style text-danger">
              {fieldError("kind")}
            </span>
          )}
        </fieldset>
        {kind === "pick" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="caption-style text-subtle mb-2">Options</legend>
            {options.map((row, index) => (
              <div key={row.key} className="flex items-center gap-2">
                <label htmlFor={`${ids.options}-${row.key}`} className="sr-only">
                  Option {index + 1}
                </label>
                <Input
                  id={`${ids.options}-${row.key}`}
                  value={row.value}
                  maxLength={AI_FIELD_OPTION_MAX}
                  onChange={(event) => updateOption(row.key, event.target.value)}
                  placeholder={`Option ${index + 1}`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${row.value || `option ${index + 1}`}`}
                  disabled={options.length <= 2}
                  onClick={() => setOptions((rows) => rows.filter((item) => item.key !== row.key))}
                >
                  <XIcon aria-hidden className="size-3.5" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={ids.many} className="caption-style text-soft flex cursor-pointer items-center gap-2">
                <Checkbox id={ids.many} checked={multiple} onCheckedChange={(value) => setMultiple(value === true)} />
                Allow more than one
              </label>
              <Button variant="ghost" size="sm" onClick={addOption} disabled={options.length >= AI_FIELD_OPTIONS_MAX}>
                <PlusIcon aria-hidden className="size-3" />
                Add option
              </Button>
            </div>
            {fieldError("options") && (
              <span role="alert" className="caption-style text-danger">
                {fieldError("options")}
              </span>
            )}
          </fieldset>
        )}
        {kind === "number" && (
          <label htmlFor={ids.size} className="caption-style text-soft flex cursor-pointer items-start gap-2">
            <Checkbox id={ids.size} checked={sizeTicked} onCheckedChange={(value) => setFillsSize(value === true)} className="mt-px" />
            <span>Fill Size when it&apos;s empty</span>
          </label>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Column name" htmlFor={ids.label} error={fieldError("label")}>
            <Input id={ids.label} value={label} maxLength={AI_FIELD_LABEL_MAX} onChange={(event) => setLabel(event.target.value)} placeholder="Sells GEO" required />
          </Field>
          <Field label="Companies" htmlFor={ids.scope} error={fieldError("scopeViewId")}>
            <NativeSelect id={ids.scope} value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="all">All with a website{count(counts?.all)}</option>
              <option value="fit">Fit Good or better{count(counts?.fit)}</option>
              {views.map((view) => (
                <option key={view.id} value={`view:${view.id}`}>
                  View: {view.name}
                  {count(counts?.views[view.id])}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle mb-2">Refresh</legend>
          <span role="radiogroup" aria-label="Refresh" className="flex w-fit max-w-full flex-wrap items-center rounded-full bg-white/[0.04] p-0.5">
            {AI_FIELD_REFRESH.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === refresh}
                onClick={() => setRefresh(option)}
                className={cn(
                  "caption-style cursor-pointer rounded-full px-3 py-1.5 whitespace-nowrap outline-none transition-colors duration-150 ease-power3-out focus-visible:ring-2 focus-visible:ring-ring/60",
                  option === refresh ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
                )}
              >
                {AI_FIELD_REFRESH_LABELS[option]}
              </button>
            ))}
          </span>
          <span className="caption-style text-subtle">New companies are checked when they&apos;re added.</span>
        </fieldset>
        <div role="status" className="flex flex-col gap-1 rounded-lg bg-white/[0.04] px-3 py-2.5">
          {hint ? (
            <>
              <span className="ui-style text-foreground">{hint.text}</span>
              <span className="caption-style text-subtle">{hint.note}</span>
            </>
          ) : (
            <span className="caption-style text-subtle">Counting companies…</span>
          )}
        </div>
        {general && (
          <p role="alert" className="caption-style text-danger">
            {general}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={saving}>
          {saving ? "Saving…" : field ? "Save" : "Save and fill"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function AiFieldDialog({ open, onOpenChange, field, views, onSaved }: DialogProps) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <FieldForm
          key={field?.id ?? "new"}
          field={field ?? null}
          views={views}
          onCancel={() => onOpenChange(false)}
          onDone={(saved) => {
            onSaved?.(saved);
            onOpenChange(false);
            router.refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
