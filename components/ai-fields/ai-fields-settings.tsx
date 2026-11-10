"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import Switch from "@/components/_ui/switch";
import { SettingsCard, SettingsPage } from "@/components/crm/settings-ui";
import AiFieldDialog from "@/components/ai-fields/field-dialog";
import { shortDate } from "@/components/ai-fields/ai-cells";
import { useHeldChecking } from "@/components/ai-fields/column-menu";
import { checkFieldAgainAction, removeAiFieldAction, setAiFieldPausedAction } from "@/app/(crm)/ai-fields";
import { AI_FIELD_KIND_LABELS, AI_FIELD_REFRESH_LABELS, money, MONTHLY_LIMIT_USD, type AiField, type AiFieldStats, type CompanyView } from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

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

export default function AiFieldsSettings({
  fields,
  stats,
  spend,
  views,
  configured,
  canAdmin,
  children,
}: {
  fields: AiField[];
  stats: AiFieldStats[];
  spend: number;
  views: CompanyView[];
  configured: boolean;
  canAdmin: boolean;
  children?: ReactNode;
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
  const description = configured ? `This month: ${money(spend)} of $${MONTHLY_LIMIT_USD}.${refresh}` : "Add PARALLEL_API_KEY in Vercel";

  return (
    <SettingsPage title="AI fields" action={add}>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <SettingsCard title="Fields" description={description}>
        {fields.length === 0 ? (
          <p className="caption-style text-subtle">{canAdmin ? "No AI fields" : "No AI fields. Owners and admins can add them."}</p>
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
          </ul>
        )}
      </SettingsCard>
      {children}
      {canAdmin && <AiFieldDialog open={dialog.open} field={dialog.field} views={views} onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} />}
    </SettingsPage>
  );
}
