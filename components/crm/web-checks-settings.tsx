"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { NativeSelect } from "@/components/_ui/native-select";
import Switch from "@/components/_ui/switch";
import { SettingsCard } from "@/components/crm/settings-ui";
import { backfillWebChecksAction, listWebChecksAction, removeWebCheckAction, saveEnrichmentSettingsAction, saveWebCheckAction } from "@/app/(crm)/enrichment";
import type { EnrichmentSettings } from "@/lib/enrichment/settings";
import type { SignalNoteKind, WebCheck, WebCheckKind } from "@/lib/enrichment/web-checks";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import { cn } from "@/lib/utils";

const NOTE_LABELS: Record<SignalNoteKind, string> = { funding: "Funding", hire: "People", launch: "Launch", signal: "Other" };

function Status({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="caption-style text-subtle flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

function Toggle({ title, caption, on, canAdmin, disabled, onChange }: { title: string; caption: string; on: boolean; canAdmin: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const change = (value: boolean) => {
    if (!disabled) onChange(value);
  };
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-5">{title}</span>
        <span className="caption-style text-subtle leading-[1.4]">{caption}</span>
      </span>
      {canAdmin ? <Switch checked={on} label={title} disabled={disabled} onChange={change} /> : <Status on={on}>{on ? "On" : "Off"}</Status>}
    </label>
  );
}

function Rules({
  kind,
  checks,
  canAdmin,
  onSaved,
  onRemoved,
}: {
  kind: WebCheckKind;
  checks: WebCheck[];
  canAdmin: boolean;
  onSaved: (check: WebCheck) => void;
  onRemoved: (id: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [question, setQuestion] = useState("");
  const [noteKind, setNoteKind] = useState<SignalNoteKind>("signal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const questionId = useId();
  const kindId = useId();

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await saveWebCheckAction({ kind, label, question, noteKind });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSaved(result.check);
      setLabel("");
      setQuestion("");
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const result = await removeWebCheckAction(id);
      if ("error" in result) setError(result.error);
      else onRemoved(id);
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("That didn't go through. Try again.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {checks.length > 0 ? (
        <ul className="flex flex-col">
          {checks.map((check) => (
            <li key={check.id} className="border-border flex items-start justify-between gap-3 border-t py-2 first:border-t-0">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground text-[13.5px] leading-5">
                  {check.label}
                  {kind === "signal" && <span className="text-subtle"> · {NOTE_LABELS[check.noteKind]}</span>}
                </span>
                <span className="caption-style text-subtle leading-[1.4]">{check.question}</span>
              </span>
              {canAdmin && (
                <HoldButton tone="neutral" onConfirm={() => void remove(check.id)}>
                  Remove<span className="sr-only"> {check.label}</span>
                </HoldButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="caption-style text-subtle">{kind === "tag" ? "No tag rules yet." : "No signals yet."}</p>
      )}
      {canAdmin && (
        <form onSubmit={add} className="flex flex-col gap-2">
          <div className={cn("grid gap-2", kind === "signal" ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1")}>
            <label htmlFor={labelId} className="sr-only">
              {kind === "tag" ? "Tag" : "Signal name"}
            </label>
            <Input id={labelId} value={label} maxLength={60} placeholder={kind === "tag" ? "Tag, such as agency" : "Signal, such as Raised money"} onChange={(event) => setLabel(event.target.value)} />
            {kind === "signal" && (
              <>
                <label htmlFor={kindId} className="sr-only">
                  Type
                </label>
                <NativeSelect id={kindId} value={noteKind} onChange={(event) => setNoteKind(event.target.value as SignalNoteKind)}>
                  {(Object.keys(NOTE_LABELS) as SignalNoteKind[]).map((key) => (
                    <option key={key} value={key}>
                      {NOTE_LABELS[key]}
                    </option>
                  ))}
                </NativeSelect>
              </>
            )}
          </div>
          <label htmlFor={questionId} className="sr-only">
            Question
          </label>
          <Input
            id={questionId}
            value={question}
            maxLength={1000}
            placeholder={kind === "tag" ? "Is the company a marketing, content or SEO agency?" : "Has the company opened a new office in the last 30 days?"}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" type="submit" disabled={busy || !label.trim() || question.trim().length < 10}>
              {busy ? "Adding…" : kind === "tag" ? "Add rule" : "Add signal"}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Backfill({ initial, blocked }: { initial: number; blocked: string | null }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(initial);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function run() {
    setRunning(true);
    setMessage(null);
    let total = 0;
    let updated = 0;
    let left = remaining;
    try {
      for (let round = 0; round < 50; round += 1) {
        const payload = await backfillWebChecksAction();
        if ("error" in payload) {
          setMessage({ text: payload.error, error: true });
          return;
        }
        total += payload.results.length;
        updated += payload.results.filter((result) => result.status === "updated").length;
        setDone(total);
        setRemaining(payload.remaining);
        if (payload.results.length === 0 || payload.remaining === 0 || payload.remaining >= left) break;
        left = payload.remaining;
      }
      setMessage({ text: `Checked ${total} ${total === 1 ? "company" : "companies"} and updated ${updated}.`, error: false });
      router.refresh();
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "That stopped early. Try again.", error: true });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-5">Check existing companies</span>
        <span className="caption-style text-subtle">
          {blocked
            ? blocked
            : running
            ? `Checking… ${done} done, ${remaining} to go`
            : remaining > 0
              ? `${remaining} ${remaining === 1 ? "company hasn't" : "companies haven't"} been checked. $0.001 each.`
              : "Every company with a website has been checked."}
        </span>
        {message && (
          <span role={message.error ? "alert" : "status"} className={cn("caption-style", message.error ? "text-danger" : "text-subtle")}>
            {message.text}
          </span>
        )}
      </span>
      <Button variant="secondary" size="sm" disabled={running || remaining === 0 || Boolean(blocked)} onClick={run}>
        {running ? "Checking…" : "Check now"}
      </Button>
    </div>
  );
}

function IdealCustomer({ initial, learned, canAdmin, onSaved }: { initial: string; learned: string | null; canAdmin: boolean; onSaved: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const id = useId();

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveEnrichmentSettingsAction({ icpText: value });
      if ("error" in result) setMessage({ text: result.error, error: true });
      else {
        onSaved(result.icpText);
        setMessage({ text: "Saved. Companies are rescored when you next check them.", error: false });
      }
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "That didn't save. Try again.", error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="caption-style text-subtle">
        Ideal customer
      </label>
      <Textarea
        id={id}
        rows={4}
        maxLength={20000}
        value={value}
        readOnly={!canAdmin}
        placeholder="UK content and SEO agencies of 10 to 50 people that sell to B2B brands"
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="caption-style text-subtle leading-[1.4]">
        {value.trim() ? "Companies are scored against this. Saving a change makes them due for rescoring." : "Describe your ideal customer to score companies."}
      </span>
      {canAdmin && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {learned && learned !== value.trim() && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setValue(learned)}>
              Use what Orbit has learned
            </Button>
          )}
          {message && (
            <span role={message.error ? "alert" : "status"} className={cn("caption-style", message.error ? "text-danger" : "text-subtle")}>
              {message.text}
            </span>
          )}
          <Button variant="secondary" size="sm" disabled={busy || value.trim() === initial.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function WebChecksSettings({
  settings,
  checks: initialChecks,
  configured,
  canAdmin,
  unchecked,
  learnedIcp,
}: {
  settings: EnrichmentSettings;
  checks: WebCheck[];
  configured: boolean;
  canAdmin: boolean;
  unchecked: number;
  learnedIcp: string | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(settings);
  const [checks, setChecks] = useState(initialChecks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(key: "webTags" | "webGaps" | "webSignals" | "webIcp", value: boolean) {
    const previous = current;
    const next = { ...current, [key]: value };
    setCurrent(next);
    setBusy(true);
    setError(null);
    try {
      const result = await saveEnrichmentSettingsAction({ [key]: value });
      if ("error" in result) {
        setCurrent(previous);
        setError(result.error);
        return;
      }
      setCurrent(result);
      if (next.webSignals && !previous.webSignals) {
        const listed = await listWebChecksAction();
        if ("checks" in listed) setChecks(listed.checks);
      }
      router.refresh();
    } catch (problem) {
      setCurrent(previous);
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const saved = (check: WebCheck) => {
    setChecks((list) => [...list.filter((item) => item.id !== check.id), check]);
    router.refresh();
  };
  const removed = (id: string) => {
    setChecks((list) => list.filter((item) => item.id !== id));
    router.refresh();
  };
  const tags = checks.filter((check) => check.kind === "tag");
  const signals = checks.filter((check) => check.kind === "signal");

  return (
    <SettingsCard
      id="web-checks"
      title="Web checks"
      description="Answers questions about each company from the live web with Parallel, for $0.001 a company. Only adds to what context.dev finds, never replaces it."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-foreground text-[13.5px] leading-5">Parallel</span>
          <Status on={configured}>{configured ? "Key set" : "Add PARALLEL_API_KEY in Vercel"}</Status>
        </div>
        <div className="flex flex-col gap-3">
          <Toggle
            title="Tag new companies"
            caption="Adds a tag when the web shows its rule is very likely true. Never removes tags."
            on={current.webTags}
            canAdmin={canAdmin}
            disabled={busy}
            onChange={(value) => void save("webTags", value)}
          />
          <Rules kind="tag" checks={tags} canAdmin={canAdmin} onSaved={saved} onRemoved={removed} />
        </div>
        <Toggle
          title="Fill gaps"
          caption="Fills size and industry when context.dev leaves them empty. Industry is picked from the ones you already use."
          on={current.webGaps}
          canAdmin={canAdmin}
          disabled={busy}
          onChange={(value) => void save("webGaps", value)}
        />
        <div className="flex flex-col gap-3">
          <Toggle
            title="ICP fit"
            caption="Scores each company from 0 to 4 against your ideal customer, with the sources it used. Adds a Fit column to Companies."
            on={current.webIcp}
            canAdmin={canAdmin}
            disabled={busy}
            onChange={(value) => void save("webIcp", value)}
          />
          {current.webIcp && (
            <IdealCustomer key={current.icpText ?? ""} initial={current.icpText ?? ""} learned={learnedIcp} canAdmin={canAdmin} onSaved={(value) => {
              setCurrent((settings) => ({ ...settings, icpText: value }));
              router.refresh();
            }} />
          )}
        </div>
        {canAdmin && configured && (current.webTags || current.webGaps || current.webIcp) && (
          <Backfill
            key={unchecked}
            initial={unchecked}
            blocked={current.webIcp && !current.webTags && !current.webGaps && !current.icpText ? "Describe your ideal customer first." : null}
          />
        )}
        <div className="flex flex-col gap-3">
          <Toggle
            title="Weekly signals"
            caption="Checks customers, prospects and companies with an open deal once a week. Anything likely goes into market notes and the morning brief."
            on={current.webSignals}
            canAdmin={canAdmin}
            disabled={busy}
            onChange={(value) => void save("webSignals", value)}
          />
          {(current.webSignals || signals.length > 0) && <Rules kind="signal" checks={signals} canAdmin={canAdmin} onSaved={saved} onRemoved={removed} />}
        </div>
        {error && (
          <p role="alert" className="caption-style text-danger leading-[1.4]">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
