"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import Switch from "@/components/_ui/switch";
import { RecordTag } from "@/components/beautifui/record-marks";
import { SettingsCard, SettingsPage } from "@/components/crm/settings-ui";
import AiFieldDialog from "@/components/ai-fields/field-dialog";
import { shortDate } from "@/components/ai-fields/ai-cells";
import { useHeldChecking } from "@/components/ai-fields/column-menu";
import { checkFieldAgainAction, removeAiFieldAction, setAiFieldPausedAction, showRuleAsColumnAction } from "@/app/(crm)/ai-fields";
import { AI_FIELD_KIND_LABELS, AI_FIELD_REFRESH_LABELS, money, MONTHLY_LIMIT_USD, type AiField, type AiFieldStats, type CompanyView } from "@/lib/ai-fields/types";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type Rule = { id: string; label: string; question: string; tagged: number };

function scopeText(field: AiField) {
  if (field.scope === "fit") return "Fit Good or better";
  if (field.scope === "view") return field.scopeViewName ? `View: ${field.scopeViewName}` : "A deleted view";
  return "All companies with a website";
}

function Coverage({ done, total, filling }: { done: number; total: number; filling: boolean }) {
  const width = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span aria-hidden className="block h-1 w-full max-w-[12rem] overflow-hidden rounded-full bg-white/8">
      <span className={cn("block h-full rounded-full", filling ? "bg-primary" : "bg-success")} style={{ width: `${width}%` }} />
    </span>
  );
}

function FieldRow({
  field,
  stats,
  canAdmin,
  configured,
  onEdit,
  onError,
}: {
  field: AiField;
  stats: AiFieldStats | undefined;
  canAdmin: boolean;
  configured: boolean;
  onEdit: () => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useHeldChecking();
  const total = stats?.total ?? 0;
  const answered = stats?.answered ?? 0;
  const checked = stats?.checked ?? 0;
  const running = (stats?.running ?? 0) > 0;
  const filling = configured && !field.paused && (running || checked < total);
  const lastRun = shortDate(field.lastRunAt);
  const refresh = field.paused ? "Paused" : `${AI_FIELD_REFRESH_LABELS[field.refresh]}${lastRun ? `, last run ${lastRun}` : ""}`;

  async function run(action: () => Promise<{ error: string } | object>) {
    setBusy(true);
    onError(null);
    const result = await action();
    setBusy(false);
    if ("error" in result) onError(result.error as string);
    else router.refresh();
    return !("error" in result);
  }

  async function checkAll() {
    setChecking(true);
    if (!(await run(() => checkFieldAgainAction(field.id)))) setChecking(false);
  }

  return (
    <li className="border-border flex flex-col gap-2.5 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground text-[13.5px] leading-5">
            {field.label}
            <span className="text-subtle"> · {AI_FIELD_KIND_LABELS[field.kind]}</span>
          </span>
          <span className="caption-style text-subtle leading-[1.4]">{field.question}</span>
          {field.kind === "pick" && <span className="caption-style text-subtle leading-[1.4]">{field.options.join(", ")}{field.multiple ? " (more than one allowed)" : ""}</span>}
        </span>
        {canAdmin ? (
          <span className="caption-style text-subtle flex shrink-0 items-center gap-2">
            <span aria-hidden>Keep up to date</span>
            <Switch checked={!field.paused} label={`Keep ${field.label} up to date`} disabled={busy} onChange={(on) => void run(() => setAiFieldPausedAction(field.id, !on))} />
          </span>
        ) : (
          <span className="caption-style text-subtle shrink-0">{field.paused ? "Paused" : "Kept up to date"}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Coverage done={filling ? checked : answered} total={total} filling={filling} />
        <span className="caption-style text-soft">
          {filling ? `Filling: ${checked} of ${total} checked, ${answered} answered` : `${answered} of ${total} answered`}
          <span className="text-subtle">
            {" "}
            · {scopeText(field)} · {refresh}
          </span>
        </span>
        {field.lastError && (
          <span role="alert" className="caption-style text-danger">
            {field.lastError}
          </span>
        )}
      </div>
      {canAdmin && (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || running || checking} onClick={() => void checkAll()}>
            {checking || running ? "Checking…" : "Check all again"}
          </Button>
          <span className="ml-auto">
            <HoldButton disabled={busy} onConfirm={() => void run(() => removeAiFieldAction(field.id))}>
              Hold to delete<span className="sr-only"> {field.label}</span>
            </HoldButton>
          </span>
        </div>
      )}
    </li>
  );
}

function FitRow() {
  return (
    <li className="border-border flex items-start justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-5">
          Fit<span className="text-subtle"> · Score 0 to 4 · Built in</span>
        </span>
        <span className="caption-style text-subtle leading-[1.4]">How well each company matches your ideal customer. Set up in Integrations, Web checks.</span>
      </span>
      <Button variant="ghost" size="sm" href={`${SETTINGS_PATHS.integrations}#web-checks`}>
        Open
      </Button>
    </li>
  );
}

function RuleRow({ rule, shown, canAdmin, onError }: { rule: Rule; shown: boolean; canAdmin: boolean; onError: (message: string | null) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function show() {
    setBusy(true);
    onError(null);
    const result = await showRuleAsColumnAction(rule.id);
    setBusy(false);
    if ("error" in result) onError(result.error);
    else router.refresh();
  }
  return (
    <li className="border-border flex items-start justify-between gap-3 border-t py-2.5 first:border-t-0 first:pt-0">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <RecordTag label={rule.label} />
          <span className="caption-style text-subtle">{rule.tagged.toLocaleString("en-GB")} tagged</span>
        </span>
        <span className="caption-style text-subtle leading-[1.4]">{rule.question}</span>
      </span>
      {shown ? (
        <span className="caption-style text-subtle shrink-0 pt-1">Shown as a column</span>
      ) : (
        canAdmin && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void show()}>
            {busy ? "Adding…" : "Show as column"}
            <span className="sr-only"> for {rule.label}</span>
          </Button>
        )
      )}
    </li>
  );
}

export default function AiFieldsSettings({
  fields,
  stats,
  spend,
  views,
  rules,
  fit,
  configured,
  canAdmin,
}: {
  fields: AiField[];
  stats: AiFieldStats[];
  spend: number;
  views: CompanyView[];
  rules: Rule[];
  fit: boolean;
  configured: boolean;
  canAdmin: boolean;
}) {
  const [dialog, setDialog] = useState<{ open: boolean; field: AiField | null }>({ open: false, field: null });
  const [error, setError] = useState<string | null>(null);
  const add = canAdmin ? (
    <Button variant="primary" size="sm" onClick={() => setDialog({ open: true, field: null })}>
      <PlusIcon aria-hidden className="size-3" />
      Add AI field
    </Button>
  ) : undefined;
  const next = stats
    .map((item) => item.nextCheckAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const refresh = next ? ` Next refresh ${shortDate(next)}.` : "";
  const description = configured ? `Checked by Parallel. This month: ${money(spend)} so far, limit $${MONTHLY_LIMIT_USD}.${refresh}` : "Add PARALLEL_API_KEY in Vercel to fill AI fields.";

  return (
    <SettingsPage title="AI fields" description="Questions answered for every company from the web, shown as columns on Companies." action={add}>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <SettingsCard title="Fields" description={description}>
        {fields.length === 0 && !fit ? (
          <p className="caption-style text-subtle">
            {canAdmin ? "No AI fields yet. Add one to ask a question about every company." : "No AI fields yet. Owners and admins can add them."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                stats={stats.find((item) => item.fieldId === field.id)}
                canAdmin={canAdmin}
                configured={configured}
                onEdit={() => setDialog({ open: true, field })}
                onError={setError}
              />
            ))}
            {fit && <FitRow />}
          </ul>
        )}
        {fields.length === 0 && fit && <p className="caption-style text-subtle">{canAdmin ? "Add an AI field to ask your own question about every company." : "Owners and admins can add AI fields."}</p>}
      </SettingsCard>
      {rules.length > 0 && (
        <SettingsCard
          title="Tag rules"
          description="Your tag rules in Integrations, Web checks still tag new companies. Show one as a column to see Yes, No or Unknown for every company, with sources. The rule keeps tagging."
        >
          <ul className="flex flex-col">
            {rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} shown={fields.some((field) => field.webCheckId === rule.id)} canAdmin={canAdmin} onError={setError} />
            ))}
          </ul>
        </SettingsCard>
      )}
      {canAdmin && <AiFieldDialog open={dialog.open} field={dialog.field} views={views} onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} />}
    </SettingsPage>
  );
}
