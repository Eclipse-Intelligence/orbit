import type { ReactNode } from "react";
import Link from "next/link";
import { teamsCallUrl } from "@/lib/phone";
import { cn } from "@/lib/utils";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";

export const recordSelectClass =
  "flex h-9 w-full rounded-lg border border-line-strong bg-secondary px-3 text-[14px] leading-none text-foreground outline-none";

export function RecordSelect({
  id,
  name,
  label,
  defaultValue,
  required,
  children,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2" htmlFor={id}>
      <span className="caption-style text-subtle">{label}</span>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        required={required}
        className={recordSelectClass}
      >
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
  href,
  onClick,
  action,
}: {
  title: string;
  meta: string;
  mark?: ReactNode;
  href?: string;
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
      {href ? (
        <Link href={href} className="flex min-w-0 flex-1">
          {body}
        </Link>
      ) : onClick ? (
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

export function CallLink({
  phone,
  className,
}: {
  phone: string | null | undefined;
  className?: string;
}) {
  const href = teamsCallUrl(phone);
  if (!href) return null;
  return (
    <a
      href={href}
      title="Call in Teams"
      aria-label="Call in Teams"
      className={cn(
        "text-subtle hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150 hover:bg-white/6",
        className,
      )}
    >
      <PhoneIcon aria-hidden className="size-3.5" />
    </a>
  );
}

export function DetailList({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-2 text-[14px] leading-5">
      {children}
    </dl>
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle leading-5">{label}</dt>
      <dd className="min-w-0 break-words">{children || <span className="text-subtle">—</span>}</dd>
    </>
  );
}
