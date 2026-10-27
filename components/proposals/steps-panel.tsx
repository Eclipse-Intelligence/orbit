"use client";

import { useId, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { addStepAction, emailStepsAction, moveStepAction, removeStepAction, updateStepAction } from "@/app/(crm)/proposals/actions";
import type { Step } from "@/lib/proposals/model";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import { cn } from "@/lib/utils";

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

export default function StepsPanel({
  documentId,
  initial,
  clientCompany,
  ourCompany,
  contactFirstName,
  canEmail,
  onSteps,
}: {
  documentId: string;
  initial: Step[];
  clientCompany: string;
  ourCompany: string;
  contactFirstName: string;
  canEmail: boolean;
  onSteps?: (steps: Step[]) => void;
}) {
  const [steps, setSteps] = useState(initial);
  const [synced, setSynced] = useState(initial);
  const [title, setTitle] = useState("");
  const [side, setSide] = useState<"client" | "us">("client");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "status" | "alert" } | null>(null);
  const titleId = useId();
  const sideId = useId();
  const dueId = useId();

  if (initial !== synced) {
    setSynced(initial);
    setSteps(initial);
  }

  async function run(key: string, work: () => Promise<{ data?: Step[]; error?: string }>) {
    setBusy(key);
    setMessage(null);
    try {
      const result = await work();
      if (result.data) {
        setSteps(result.data);
        onSteps?.(result.data);
        return true;
      }
      setMessage({ text: result.error ?? "That didn't save.", tone: "alert" });
      return false;
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "That didn't save. Try again.", tone: "alert" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const saved = await run("add", () => addStepAction(documentId, { title, side, dueDate: dueDate || null }));
    if (saved) {
      setTitle("");
      setDueDate("");
    }
  }

  async function email() {
    setBusy("email");
    setMessage(null);
    try {
      const result = await emailStepsAction(documentId);
      if (result.data) setMessage({ text: result.data.warning ?? `Emailed ${contactFirstName} the open steps.`, tone: result.data.warning ? "alert" : "status" });
      else setMessage({ text: result.error ?? "That didn't send.", tone: "alert" });
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "That didn't send. Try again.", tone: "alert" });
    } finally {
      setBusy(null);
    }
  }

  const openForClient = steps.filter((step) => step.side === "client" && !step.doneAt).length;

  return (
    <section aria-labelledby="steps-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="steps-heading">Next steps</h2>
        {canEmail && openForClient > 0 && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void email()}>
            {busy === "email" ? "Sending…" : `Email ${contactFirstName}`}
          </Button>
        )}
      </div>
      <p className="caption-style text-subtle">Live on the client&apos;s page. You get an alert when they tick one off.</p>
      {steps.length > 0 && (
        <ol className="flex flex-col">
          {steps.map((step, index) => (
            <li key={step.id} className="border-border flex items-start gap-3 border-t py-2.5 first:border-t-0">
              <Checkbox
                className="mt-0.5"
                checked={Boolean(step.doneAt)}
                disabled={busy !== null}
                aria-label={`${step.title} done`}
                onCheckedChange={(state) => void run(step.id, () => updateStepAction(step.id, { done: state === true }))}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("text-[14px] leading-5", step.doneAt && "text-subtle line-through")}>{step.title}</span>
                <span className="caption-style text-subtle">
                  {[step.side === "client" ? clientCompany : ourCompany, step.doneAt ? `done${step.doneName ? ` by ${step.doneName}` : ""} ${shortDate(step.doneAt)}` : step.dueDate ? `by ${shortDate(step.dueDate)}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 items-center">
                <Button variant="ghost" size="sm" disabled={busy !== null || index === 0} aria-label={`Move ${step.title} up`} onClick={() => void run(step.id, () => moveStepAction(step.id, -1))}>
                  Up
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} aria-label={`Remove ${step.title}`} onClick={() => void run(step.id, () => removeStepAction(step.id))}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={add} className="flex flex-col gap-2">
        <label htmlFor={titleId} className="sr-only">
          New step
        </label>
        <Input id={titleId} value={title} maxLength={300} placeholder="Add a step" onChange={(event) => setTitle(event.target.value)} />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          <label htmlFor={sideId} className="sr-only">
            Who
          </label>
          <NativeSelect id={sideId} value={side} onChange={(event) => setSide(event.target.value === "us" ? "us" : "client")}>
            <option value="client">{clientCompany}</option>
            <option value="us">{ourCompany}</option>
          </NativeSelect>
          <label htmlFor={dueId} className="sr-only">
            Due
          </label>
          <Input id={dueId} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          <Button variant="secondary" size="sm" type="submit" disabled={busy !== null || !title.trim()} className="h-9">
            {busy === "add" ? "Adding" : "Add"}
          </Button>
        </div>
      </form>
      {message && (
        <p role={message.tone} className={cn("caption-style", message.tone === "alert" ? "text-danger" : "text-subtle")}>
          {message.text}
        </p>
      )}
    </section>
  );
}
