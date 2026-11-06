"use client";

import { useEffect, useId, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { ScrollArea } from "@/components/_ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { AiCellValue, AiMark, shortDate, SourceList } from "@/components/ai-fields/ai-cells";
import { checkCompanyAgainAction, getAnswerAction, restoreWebAnswerAction, setManualAnswerAction } from "@/app/(crm)/ai-fields";
import { displayAiValue, likelihoodText, type AiAnswer, type AiCell, type AiField, type AiValue } from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const PHONE_QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void) {
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function usePhone() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

function answerText(field: AiField, answer: Pick<AiAnswer, "state" | "value">) {
  if (answer.state === "answered") return displayAiValue(field, answer.value) || "None";
  if (answer.state === "unknown") return "Unknown";
  if (answer.state === "checking") return "Checking…";
  return "Not checked";
}

function likelihoodLine(field: AiField, answer: AiAnswer) {
  if (answer.manual) return null;
  if (answer.state === "unknown" && field.kind === "yes_no" && answer.likelihood !== null && !answer.confidence) {
    return `Not sure, ${Math.round(answer.likelihood * 100)}% likely yes`;
  }
  if (answer.state !== "answered" && !answer.confidence) return null;
  return likelihoodText(answer);
}

function draftFrom(field: AiField, value: AiValue): string | string[] {
  if (field.kind === "yes_no") return value === true ? "yes" : value === false ? "no" : "";
  if (field.kind === "pick") return Array.isArray(value) ? value : [];
  if (value === null || value === undefined) return "";
  return String(value);
}

function AnswerEditor({ field, answer, onSaved, onCancel }: { field: AiField; answer: AiAnswer; onSaved: (answer: AiAnswer) => void; onCancel: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | string[]>(() => draftFrom(field, answer.value));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const web = answer.manual ? answer.web : answer.state === "answered" || answer.state === "unknown" ? { state: answer.state, value: answer.value, likelihood: answer.likelihood, confidence: answer.confidence } : null;
  const webLikelihood = web ? likelihoodText(web) : null;
  const webText = web ? `${web.state === "answered" ? displayAiValue(field, web.value) || "None" : "Unknown"}${webLikelihood ? `, ${webLikelihood.toLowerCase()}` : ""}` : null;

  function save() {
    setError(null);
    const value = field.kind === "pick" ? draft : typeof draft === "string" ? draft.trim() || null : null;
    start(async () => {
      const result = await setManualAnswerAction(field.id, answer.companyId, value);
      if ("error" in result) setError(result.error);
      else onSaved(result.answer);
    });
  }

  const picked = Array.isArray(draft) ? draft : [];
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={`${id}-value`} className="sr-only">
        {field.label}
      </label>
      {field.kind === "yes_no" && (
        <NativeSelect id={`${id}-value`} value={typeof draft === "string" ? draft : ""} onChange={(event) => setDraft(event.target.value)}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="">Unknown</option>
        </NativeSelect>
      )}
      {(field.kind === "number" || field.kind === "text") && (
        <Input
          id={`${id}-value`}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          value={typeof draft === "string" ? draft : ""}
          placeholder="Unknown"
          maxLength={field.kind === "text" ? 300 : 20}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {field.kind === "pick" && !field.multiple && (
        <NativeSelect id={`${id}-value`} value={picked[0] ?? ""} onChange={(event) => setDraft(event.target.value ? [event.target.value] : [])}>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          <option value="">Unknown</option>
        </NativeSelect>
      )}
      {field.kind === "pick" && field.multiple && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">{field.label}</legend>
          {field.options.map((option, index) => (
            <label key={option} htmlFor={`${id}-option-${index}`} className="ui-style text-soft flex items-center gap-2">
              <Checkbox
                id={`${id}-option-${index}`}
                checked={picked.includes(option)}
                onCheckedChange={(checked) => setDraft(checked === true ? [...picked, option] : picked.filter((item) => item !== option))}
              />
              {option}
            </label>
          ))}
        </fieldset>
      )}
      {webText && <span className="caption-style text-subtle">Web answer: {webText}. Saving your own keeps it and stops checks.</span>}
      {!webText && <span className="caption-style text-subtle">Saving your own keeps it and stops checks.</span>}
      {error && (
        <span role="alert" className="caption-style text-danger">
          {error}
        </span>
      )}
      <span className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </span>
    </form>
  );
}

export function AnswerDetail({ field, companyId, canManage, showTitle = true }: { field: AiField; companyId: string; canManage: boolean; showTitle?: boolean }) {
  const router = useRouter();
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void getAnswerAction(field.id, companyId).then((result) => {
      if (!live) return;
      if ("error" in result) setError(result.error);
      else setAnswer(result.answer);
    });
    return () => {
      live = false;
    };
  }, [field.id, companyId]);

  function changed(next: AiAnswer) {
    setAnswer(next);
    setEditing(false);
    router.refresh();
  }

  function checkAgain() {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await checkCompanyAgainAction(companyId, [field.id]);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMessage(result.message);
      const fresh = await getAnswerAction(field.id, companyId);
      if (!("error" in fresh)) setAnswer(fresh.answer);
      router.refresh();
    });
  }

  function restoreWeb() {
    setError(null);
    start(async () => {
      const result = await restoreWebAnswerAction(field.id, companyId);
      if ("error" in result) setError(result.error);
      else changed(result.answer);
    });
  }

  const likelihood = answer ? likelihoodLine(field, answer) : null;
  const checked = answer?.checkedAt ? `Checked ${shortDate(answer.checkedAt, true)}` : null;
  const next = answer?.nextCheckAt ? `Next check ${shortDate(answer.nextCheckAt)}` : null;
  const timing = answer?.manual
    ? `Set by you${answer.manualAt ? ` on ${shortDate(answer.manualAt)}` : ""}, not checked again`
    : [checked, next].filter(Boolean).join(". ");

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          {showTitle && (
            <span className="caption-style text-subtle flex items-center gap-1.5">
              <AiMark />
              {field.label}
            </span>
          )}
          <p className="caption-style text-soft">{field.question}</p>
        </div>
        {!answer && !error && (
          <span role="status" className="caption-style text-subtle">
            Loading…
          </span>
        )}
        {answer && !editing && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="leading-5">{answerText(field, answer)}</h3>
              {likelihood && <span className="caption-style text-subtle">{likelihood}</span>}
            </div>
            {answer.state === "checking" && <p className="ui-style text-soft">Checking this company now.</p>}
            {answer.state === "outside" && <p className="ui-style text-soft">This company isn&apos;t in this field&apos;s companies.</p>}
            {answer.reason && <p className="ui-style text-soft">“{answer.reason}”</p>}
          </>
        )}
        {answer && editing && <AnswerEditor field={field} answer={answer} onSaved={changed} onCancel={() => setEditing(false)} />}
        {error && (
          <span role="alert" className="caption-style text-danger">
            {error}
          </span>
        )}
        {message && (
          <span role="status" className="caption-style text-subtle">
            {message}
          </span>
        )}
      </div>
      {answer && answer.sources.length > 0 && !editing && (
        <div className="border-border flex flex-col gap-1.5 border-t px-4 py-3">
          <span className="caption-style text-subtle">Sources</span>
          <SourceList sources={answer.sources} />
        </div>
      )}
      {answer && !editing && (timing || canManage) && (
        <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
          <span className="caption-style text-subtle flex flex-wrap items-center gap-x-2">
            {timing ? `${timing}.` : null}
            {answer.manual && canManage && (
              <Button variant="link" size="none" className="caption-style text-subtle" onClick={restoreWeb} disabled={pending}>
                Use web answer
              </Button>
            )}
          </span>
          {canManage && (
            <span className="flex items-center gap-1">
              {!answer.manual && answer.state !== "outside" && (
                <Button variant="ghost" size="sm" onClick={checkAgain} disabled={pending}>
                  <RefreshIcon aria-hidden className="size-3" />
                  {pending ? "Checking…" : "Check again"}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={pending}>
                <EditIcon aria-hidden className="size-3" />
                Edit answer
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function AiCellButton({ field, cell, companyId, companyName, canManage }: { field: AiField; cell: AiCell | undefined; companyId: string; companyName: string; canManage: boolean }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const value = <AiCellValue field={field} cell={cell} />;
  const label = `${field.label} for ${companyName}. Show answer and sources`;
  const buttonClass = cn(
    "-mx-1.5 cursor-pointer rounded-md px-1.5 py-1 outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60",
    open && "bg-white/6",
  );
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <button type="button" aria-label={label} aria-expanded={open} className={buttonClass} onClick={() => setOpen(true)}>
          {value}
        </button>
        <SheetContent side="bottom" onClick={(event) => event.stopPropagation()}>
          <SheetHeader className="px-4">
            <SheetTitle className="truncate">{companyName}</SheetTitle>
            <SheetDescription className="sr-only">{field.label} answer and sources</SheetDescription>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close">
                <XIcon aria-hidden className="text-foreground size-4" />
              </Button>
            </SheetClose>
          </SheetHeader>
          <ScrollArea viewportClassName="max-h-[calc(85dvh-56px)]">{open && <AnswerDetail field={field} companyId={companyId} canManage={canManage} />}</ScrollArea>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={buttonClass}>
          {value}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" onClick={(event) => event.stopPropagation()}>
        {open && <AnswerDetail field={field} companyId={companyId} canManage={canManage} />}
      </PopoverContent>
    </Popover>
  );
}
