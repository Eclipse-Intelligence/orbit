"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { RecordTag } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import { pickColour, shortDate, SourceList } from "@/components/ai-fields/ai-cells";
import { checkCompanyAgainAction, restoreWebAnswerAction, setManualAnswerAction } from "@/app/(crm)/ai-fields";
import { displayAiValue, likelihoodText, type AiAnswer, type AiField, type AiSource, type AiValue } from "@/lib/ai-fields/types";
import type { CompanyFit } from "@/lib/enrichment/web-checks";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle leading-5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Sources({ sources, checkedAt }: { sources: AiSource[]; checkedAt: string | null }) {
  const when = shortDate(checkedAt);
  if (sources.length === 0) return when ? <span className="caption-style text-subtle">Checked {when}</span> : null;
  return (
    <details className="caption-style text-subtle">
      <summary className="w-fit cursor-pointer rounded-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {sources.length} {sources.length === 1 ? "source" : "sources"}
        {when ? ` · ${when}` : ""}
      </summary>
      <div className="mt-1.5">
        <SourceList sources={sources} />
      </div>
    </details>
  );
}

function Shown({ field, value }: { field: AiField; value: AiValue }) {
  if (field.kind === "pick" && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((option) => (
          <RecordTag key={option} label={option} base={pickColour(field, option)} />
        ))}
      </span>
    );
  }
  return <span className="tabular-nums">{displayAiValue(field, value)}</span>;
}

function editValue(field: AiField, value: AiValue) {
  if (value === null || value === undefined) return field.kind === "pick" ? [] : "";
  if (field.kind === "yes_no") return value === true ? "yes" : "no";
  if (field.kind === "pick") return Array.isArray(value) ? value : [];
  return String(value);
}

function webSummary(field: AiField, answer: AiAnswer) {
  const web = answer.manual ? answer.web : answer.state === "answered" || answer.state === "unknown" ? answer : null;
  if (!web) return null;
  if (web.state !== "answered") return "Web answer: Unknown.";
  const likely = likelihoodText({ likelihood: web.likelihood, confidence: web.confidence, state: web.state });
  return `Web answer: ${displayAiValue(field, web.value)}${likely ? `, ${likely.toLowerCase()}` : ""}.`;
}

function Editor({ field, answer, companyId, onDone }: { field: AiField; answer: AiAnswer; companyId: string; onDone: (answer: AiAnswer | null) => void }) {
  const id = useId();
  const [value, setValue] = useState<string | string[]>(() => editValue(field, answer.state === "answered" ? answer.value : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = webSummary(field, answer);

  async function save() {
    setSaving(true);
    setError(null);
    const sent = field.kind === "yes_no" ? (value === "yes" ? true : value === "no" ? false : null) : value;
    const result = await setManualAnswerAction(field.id, companyId, sent);
    setSaving(false);
    if ("error" in result) setError(result.error);
    else onDone(result.answer);
  }

  const control =
    field.kind === "yes_no" ? (
      <NativeSelect id={id} value={value as string} onChange={(event) => setValue(event.target.value)}>
        <option value="yes">Yes</option>
        <option value="no">No</option>
        <option value="">Unknown</option>
      </NativeSelect>
    ) : field.kind === "pick" && !field.multiple ? (
      <NativeSelect id={id} value={(value as string[])[0] ?? ""} onChange={(event) => setValue(event.target.value ? [event.target.value] : [])}>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value="">Unknown</option>
      </NativeSelect>
    ) : field.kind === "pick" ? (
      <fieldset id={id} className="flex flex-col gap-1.5">
        <legend className="sr-only">{field.label}</legend>
        {field.options.map((option, index) => {
          const ticked = (value as string[]).includes(option);
          return (
            <label key={option} htmlFor={`${id}-${index}`} className="caption-style text-soft flex cursor-pointer items-center gap-2">
              <Checkbox
                id={`${id}-${index}`}
                checked={ticked}
                onCheckedChange={(next) => setValue((current) => (next === true ? [...(current as string[]), option] : (current as string[]).filter((item) => item !== option)))}
              />
              {option}
            </label>
          );
        })}
      </fieldset>
    ) : (
      <Input
        id={id}
        value={value as string}
        inputMode={field.kind === "number" ? "decimal" : undefined}
        maxLength={field.kind === "text" ? 300 : 30}
        placeholder="Unknown"
        onChange={(event) => setValue(event.target.value)}
      />
    );

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {field.kind !== "pick" || !field.multiple ? (
        <label htmlFor={id} className="sr-only">
          {field.label}
        </label>
      ) : null}
      {control}
      <span className="caption-style text-subtle leading-[1.4]">
        {summary ? `${summary} ` : ""}Saving your own keeps it and stops checks.
      </span>
      {error && (
        <span role="alert" className="caption-style text-danger">
          {error}
        </span>
      )}
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => onDone(null)} disabled={saving}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </span>
    </form>
  );
}

function Answer({ field, answer, companyId, canEdit }: { field: AiField; answer: AiAnswer; companyId: string; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(answer);
  const [given, setGiven] = useState(answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (given !== answer) {
    setGiven(answer);
    setCurrent(answer);
  }
  const shown = current;

  if (editing) {
    return (
      <Editor
        field={field}
        answer={shown}
        companyId={companyId}
        onDone={(saved) => {
          setEditing(false);
          if (saved) {
            setCurrent(saved);
            router.refresh();
          }
        }}
      />
    );
  }

  async function restore() {
    setBusy(true);
    setError(null);
    const result = await restoreWebAnswerAction(field.id, companyId);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else {
      setCurrent(result.answer);
      router.refresh();
    }
  }

  const value =
    shown.state === "answered" ? (
      <Shown field={field} value={shown.value} />
    ) : shown.state === "checking" ? (
      <span className="text-subtle inline-flex items-center gap-1.5">
        <span aria-hidden className="bg-subtle size-1.5 animate-pulse rounded-full" />
        Checking…
      </span>
    ) : shown.state === "outside" ? (
      <span className="text-subtle">Not checked for this company</span>
    ) : (
      <span className="text-subtle">Unknown</span>
    );
  const likely = shown.manual || shown.state !== "answered" ? null : likelihoodText(shown);

  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`${field.label}: ${shown.state === "answered" ? displayAiValue(field, shown.value) : shown.state === "checking" ? "Checking" : "Unknown"}. Edit answer`}
            className="-mx-1 cursor-pointer rounded-md px-1 text-left outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {value}
          </button>
        ) : (
          value
        )}
        {likely && <span className="caption-style text-subtle">{likely}</span>}
      </span>
      {shown.manual ? (
        <span className="caption-style text-subtle flex flex-wrap items-center gap-x-2">
          Set by you{shown.manualAt ? ` on ${shortDate(shown.manualAt)}` : ""}, not checked again
          {canEdit && (
            <Button variant="link" size="none" className="caption-style text-subtle" disabled={busy} onClick={() => void restore()}>
              Use web answer
            </Button>
          )}
        </span>
      ) : (
        <>
          {shown.reason && <span className="caption-style text-soft leading-[1.4]">“{shown.reason}”</span>}
          {(shown.state === "answered" || shown.state === "unknown") && <Sources sources={shown.sources} checkedAt={shown.checkedAt} />}
        </>
      )}
      {error && (
        <span role="alert" className="caption-style text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

export default function CompanyAiFields({
  companyId,
  fields,
  answers,
  fit,
  canAdmin,
  archived,
}: {
  companyId: string;
  fields: AiField[];
  answers: AiAnswer[];
  fit: CompanyFit;
  canAdmin: boolean;
  archived: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  if (fields.length === 0 && !fit) return null;
  const canEdit = canAdmin && !archived;

  async function checkAgain() {
    setChecking(true);
    setMessage(null);
    const result = await checkCompanyAgainAction(companyId);
    setChecking(false);
    if ("error" in result) setMessage({ text: result.error, error: true });
    else {
      setMessage({ text: result.message, error: false });
      router.refresh();
    }
  }

  return (
    <DetailSection
      title="AI fields"
      action={
        canEdit && fields.length > 0 ? (
          <Button variant="ghost" size="sm" disabled={checking} onClick={() => void checkAgain()}>
            <RefreshIcon aria-hidden className="size-3" />
            {checking ? "Checking…" : "Check again"}
          </Button>
        ) : undefined
      }
    >
      {message && (
        <p role={message.error ? "alert" : "status"} className={message.error ? "caption-style text-danger" : "caption-style text-subtle"}>
          {message.text}
        </p>
      )}
      <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-3 text-[14px] leading-5">
        {fit && (
          <Row label="ICP fit">
            <span className="flex flex-col gap-0.5">
              <span>
                {fit.label}, {fit.score.toFixed(1)} of 4
                {fit.stale && <span className="text-subtle"> (before your ICP changed)</span>}
              </span>
              <Sources sources={fit.sources} checkedAt={fit.checkedAt} />
            </span>
          </Row>
        )}
        {fields.map((field) => {
          const answer = answers.find((item) => item.fieldId === field.id);
          if (!answer) return null;
          return (
            <Row key={field.id} label={field.label}>
              <Answer field={field} answer={answer} companyId={companyId} canEdit={canEdit} />
            </Row>
          );
        })}
      </dl>
    </DetailSection>
  );
}
