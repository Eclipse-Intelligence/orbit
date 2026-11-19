"use client";

import { useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Switch from "@/components/_ui/switch";
import { Textarea } from "@/components/_ui/textarea";
import { saveCampaignVariablesAction } from "@/app/(crm)/campaigns/actions";
import type { VariableBrief } from "@/lib/campaigns/types";
import { cn } from "@/lib/utils";

const ROW = "grid grid-cols-1 gap-1.5 md:grid-cols-[9rem_minmax(0,1fr)_4.5rem_4.5rem] md:items-start md:gap-3";

type Draft = { name: string; brief: string; required: boolean; max: string };

function draftsOf(briefs: VariableBrief[]): Draft[] {
  return briefs.map((item) => ({ name: item.name, brief: item.brief, required: item.required, max: item.maxLength === null ? "" : String(item.maxLength) }));
}

export default function VariableBriefs({ campaignId, briefs, canEdit }: { campaignId: string; briefs: VariableBrief[]; canEdit: boolean }) {
  const [drafts, setDrafts] = useState(() => draftsOf(briefs));
  const [saved, setSaved] = useState(() => draftsOf(briefs));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const changed = JSON.stringify(drafts) !== JSON.stringify(saved);

  function edit(index: number, patch: Partial<Draft>) {
    setStatus(null);
    setDrafts((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const outcome = await saveCampaignVariablesAction(
      campaignId,
      drafts.map((item) => ({ name: item.name, brief: item.brief, required: item.required, maxLength: item.max.trim() ? Number(item.max) : null })),
    ).catch(() => ({ error: "Couldn't save. Try again.", briefs: undefined }));
    setPending(false);
    if (outcome.error || !outcome.briefs) {
      setStatus({ text: outcome.error ?? "Couldn't save. Try again.", error: true });
      return;
    }
    const next = draftsOf(outcome.briefs);
    setDrafts(next);
    setSaved(next);
    setStatus({ text: "Saved", error: false });
  }

  if (!canEdit) {
    return (
      <ul className="flex flex-col">
        {briefs.map((item) => (
          <li key={item.name} className={cn(ROW, "ui-style py-2")}>
            <span className="font-mono text-[12px] text-(--tag-purple-text) md:pt-0.5">{item.name}</span>
            <span className={cn("wrap-anywhere", !item.brief && "text-subtle")}>{item.brief || "No brief"}</span>
            <span className="text-subtle tabular-nums">{item.maxLength === null ? "" : `${item.maxLength.toLocaleString("en-GB")} max`}</span>
            <span className="text-subtle">{item.required ? "" : "Optional"}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3">
      <div aria-hidden className={cn(ROW, "caption-style text-subtle hidden md:grid")}>
        <span />
        <span />
        <span>Max characters</span>
        <span>Required</span>
      </div>
      <ul className="flex flex-col gap-3">
        {drafts.map((item, index) => (
          <li key={item.name} className={ROW}>
            <label htmlFor={`brief-${item.name}`} className="font-mono text-[12px] text-(--tag-purple-text) md:pt-2">
              {item.name}
            </label>
            <Textarea
              id={`brief-${item.name}`}
              rows={2}
              maxLength={2000}
              value={item.brief}
              placeholder="What it should say"
              onChange={(event) => edit(index, { brief: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <label htmlFor={`max-${item.name}`} className="caption-style text-subtle md:sr-only">
                Max characters
              </label>
              <Input
                id={`max-${item.name}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={5000}
                value={item.max}
                placeholder="·"
                onChange={(event) => edit(index, { max: event.target.value })}
                className="w-20 md:w-full"
              />
            </div>
            <div className="flex items-center gap-2 md:pt-2">
              <span aria-hidden className="caption-style text-subtle md:hidden">
                Required
              </span>
              <Switch id={`required-${item.name}`} label={`${item.name} is required`} checked={item.required} onChange={(required) => edit(index, { required })} className="hit" />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {status && (
          <span role={status.error ? "alert" : "status"} className={cn("caption-style", status.error ? "text-danger" : "text-subtle")}>
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}
