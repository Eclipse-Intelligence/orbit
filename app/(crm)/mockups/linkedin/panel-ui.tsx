"use client";

import { useId, type ComponentType, type ReactNode, type SVGProps } from "react";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Textarea } from "@/components/_ui/textarea";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import { WORKSPACES, type MockWorkspace } from "./mock-data";

function WorkspaceMenu({ current, presence }: { current: MockWorkspace; presence?: Record<string, string> }) {
  return (
    <div
      role="menu"
      aria-label="Workspaces"
      className="border-line-strong bg-popover shadow-overlay absolute top-[calc(100%+6px)] left-0 z-10 w-[16rem] rounded-lg border p-1"
    >
      <p className="caption-style text-subtle px-2 py-1.5">Save and look up in</p>
      {WORKSPACES.map((item) => {
        const selected = item.id === current.id;
        return (
          <div
            key={item.id}
            role="menuitemradio"
            aria-checked={selected}
            className={cn("ui-style text-foreground flex items-center gap-2 rounded-md px-2 py-1.5", !selected && "bg-white/6")}
          >
            <WorkspaceTile id={item.id} name={item.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{item.name}</span>
              {presence?.[item.id] && <span className="caption-style text-subtle">{presence[item.id]}</span>}
            </span>
            {selected && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

export function OrbitPanel({
  workspace,
  children,
  footer,
  menu,
  presence,
  connected = true,
}: {
  workspace: MockWorkspace;
  children: ReactNode;
  footer?: ReactNode;
  menu?: boolean;
  presence?: Record<string, string>;
  connected?: boolean;
}) {
  return (
    <div className="bg-background text-foreground flex min-h-0 flex-1 flex-col">
      {connected && (
        <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-2.5">
          <div className="relative min-w-0 flex-1">
            <Button
              variant="ghost"
              size="none"
              aria-label={`Workspace: ${workspace.name}. Change workspace`}
              aria-expanded={menu ? true : undefined}
              className={cn(
                "text-foreground hover:text-foreground min-w-0 justify-start gap-2 rounded-lg px-1.5 py-1 font-normal",
                menu && "bg-white/6",
              )}
            >
              <WorkspaceTile id={workspace.id} name={workspace.name} />
              <span className="ui-style truncate">{workspace.name}</span>
              <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />
            </Button>
            {menu && <WorkspaceMenu current={workspace} presence={presence} />}
          </div>
          <Button variant="ghost" size="icon" aria-label="Orbit menu">
            <MoreIcon aria-hidden className="size-4" />
          </Button>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-4">{children}</div>
      {footer && <div className="border-border bg-background flex shrink-0 flex-col gap-2 border-t px-4 py-3">{footer}</div>}
    </div>
  );
}

export function Status({ tone, title, detail }: { tone: "in" | "new" | "maybe" | "wait"; title: string; detail?: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-[5px] size-2 shrink-0 rounded-full",
          tone === "in" && "bg-success",
          tone === "new" && "bg-[#5a5a5a]",
          tone === "maybe" && "bg-warning",
          tone === "wait" && "bg-primary",
        )}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[14px] leading-[18px] font-medium">{title}</span>
        {detail && <span className="caption-style text-subtle leading-[1.4]">{detail}</span>}
      </span>
    </div>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="eyebrow-style text-subtle text-[11px] font-normal">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Avatar({ initials, square, className }: { initials: string; square?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-muted text-soft inline-flex size-10 shrink-0 items-center justify-center text-[13px] font-medium",
        square ? "rounded-[10px]" : "rounded-full",
        className,
      )}
    >
      {initials}
    </span>
  );
}

export function RecordHead({ initials, name, lines, square, action }: { initials: string; name: string; lines: ReactNode[]; square?: boolean; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar initials={initials} square={square} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <span className="truncate text-[15px] leading-5 font-semibold">{name}</span>
        {lines.map((line, index) => (
          <span key={index} className="caption-style text-soft leading-[1.4]">
            {line}
          </span>
        ))}
      </div>
      {action && <div className="-mt-1 -mr-1.5 shrink-0">{action}</div>}
    </div>
  );
}

export function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[6.5em_1fr] gap-x-3 gap-y-2.5 text-[13px] leading-5">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="caption-style text-subtle leading-5">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("border-border bg-card flex flex-col gap-3 rounded-xl border p-3.5", className)}>{children}</div>;
}

export function TextField({ label, value, placeholder, hint, type }: { label: string; value?: string; placeholder?: string; hint?: string; type?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input id={id} type={type} defaultValue={value} placeholder={placeholder} aria-describedby={hint ? `${id}-hint` : undefined} />
    </Field>
  );
}

export function SelectField({ label, options, value, hint }: { label: string; options: string[]; value?: string; hint?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <NativeSelect id={id} defaultValue={value ?? options[0]}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function AreaField({ label, value, placeholder, hint, rows = 4 }: { label: string; value?: string; placeholder?: string; hint?: string; rows?: number }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Textarea id={id} rows={rows} defaultValue={value} placeholder={placeholder} />
    </Field>
  );
}

export type QuickAction = { key: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

export function QuickActions({ actions, active }: { actions: QuickAction[]; active?: string }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {actions.map((action) => (
        <Button
          key={action.key}
          variant={action.key === active ? "muted" : "secondary"}
          size="md"
          aria-pressed={action.key === active}
          className={cn("h-9 justify-start rounded-lg px-3 text-[13px]", action.key !== active && "text-soft")}
        >
          <action.icon aria-hidden className="size-3.5 shrink-0" />
          {action.label}
        </Button>
      ))}
    </div>
  );
}

export function OpenInOrbit({ label = "Open in Orbit" }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" className="shrink-0">
      {label}
      <ExternalIcon aria-hidden className="size-3" />
    </Button>
  );
}

export function Chips({ values, onCard }: { values: string[]; onCard?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <span
          key={value}
          className={cn(
            "caption-style text-chip inline-flex h-[22px] items-center rounded-md border px-1.5",
            onCard ? "border-line-strong bg-muted" : "border-(--tag-neutral-border) bg-(--tag-neutral-bg)",
          )}
        >
          {value}
        </span>
      ))}
    </span>
  );
}
