import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const recordSelectClass =
  "flex h-9 w-full rounded-lg border border-line-strong bg-secondary px-3 text-[14px] leading-none text-foreground outline-none";

export function RecordSelect({
  id,
  name,
  label,
  defaultValue,
  children,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2" htmlFor={id}>
      <span className="caption-style text-subtle">{label}</span>
      <select id={id} name={name} defaultValue={defaultValue} className={recordSelectClass}>
        {children}
      </select>
    </label>
  );
}

export function RecordList({
  empty,
  children,
  count,
}: {
  empty: string;
  children: ReactNode;
  count: number;
}) {
  if (count === 0) {
    return <p className="caption-style text-subtle px-4 py-8">{empty}</p>;
  }
  return <ul className="min-h-0 flex-1 overflow-auto">{children}</ul>;
}

export function RecordRow({
  title,
  meta,
  mark,
  onClick,
  action,
}: {
  title: string;
  meta: string;
  mark?: ReactNode;
  onClick?: () => void;
  action?: ReactNode;
}) {
  const body = (
    <span className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
      {mark}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[14px] leading-5">{title}</span>
        <span className="caption-style text-subtle truncate">{meta}</span>
      </span>
    </span>
  );
  return (
    <li className={cn("border-border flex min-h-11 items-center gap-3 border-b px-2.5 py-2")}>
      {onClick ? (
        <button type="button" className="min-w-0 flex-1 cursor-pointer" onClick={onClick}>
          {body}
        </button>
      ) : (
        body
      )}
      {action}
    </li>
  );
}
