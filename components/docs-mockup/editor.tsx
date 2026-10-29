import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";

export const noteType = {
  title: "text-[30px] leading-[1.15] font-semibold tracking-[-0.022em] text-foreground",
  h2: "text-[19px] leading-[1.35] font-semibold tracking-[-0.012em] text-foreground",
  h3: "text-[16px] leading-[1.5] font-semibold text-foreground",
  body: "text-[16px] leading-[1.7] text-[#e3e5ea]",
  marker: "text-faint font-normal select-none",
};

export function NoteColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("relative mx-auto w-full max-w-[38em]", noteType.body, className)}>{children}</div>;
}

function Hanging({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className={cn("absolute top-0 right-full mr-2 whitespace-pre tabular-nums", noteType.marker)}>
      {children}
    </span>
  );
}

export function Title({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn(noteType.title, "text-balance", className)}>{children}</h1>;
}

export function H2({ children, active, className }: { children: ReactNode; active?: boolean; className?: string }) {
  return (
    <h2 className={cn("relative mt-8 mb-1.5", noteType.h2, className)}>
      {active && <Hanging>##</Hanging>}
      {children}
    </h2>
  );
}

export function H3({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("relative mt-6 mb-1", noteType.h3, className)}>{children}</h3>;
}

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("relative my-2.5", noteType.body, className)}>{children}</p>;
}

export function List({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("my-2.5 flex flex-col gap-1", className)}>{children}</ul>;
}

export function Bullet({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <li className="relative flex gap-3 pl-1">
      {active ? (
        <span aria-hidden className={cn("w-2 shrink-0", noteType.marker)}>
          -
        </span>
      ) : (
        <span aria-hidden className="flex h-[1.7em] w-2 shrink-0 items-center justify-center">
          <span className="bg-subtle size-[5px] rounded-full" />
        </span>
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

export function Task({ children, done, active }: { children: ReactNode; done?: boolean; active?: boolean }) {
  return (
    <li className="relative flex gap-3 pl-1">
      {active && <Hanging>{done ? "- [x]" : "- [ ]"}</Hanging>}
      <span className="flex h-[1.7em] shrink-0 items-center">
        <span
          role="checkbox"
          aria-checked={Boolean(done)}
          aria-label={done ? "Done" : "Not done"}
          className={cn(
            "flex size-[15px] items-center justify-center rounded-[5px] transition-colors duration-150",
            done ? "bg-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]" : "shadow-[inset_0_0_0_1.5px_#4a4a4a]",
          )}
        >
          {done && (
            <svg aria-hidden width="9" height="9" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6.2 5 8.5l4.5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </span>
      <span className={cn("min-w-0 flex-1", done && "text-subtle decoration-faint line-through decoration-1")}>{children}</span>
    </li>
  );
}

export function Quote({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <blockquote className="border-line-strong text-soft relative my-4 border-l-2 pl-4">
      {active && <Hanging>&gt;</Hanging>}
      {children}
    </blockquote>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="text-chip rounded-[5px] bg-white/[0.07] px-[5px] py-[1px] font-mono text-[14px]">{children}</code>;
}

export function CodeBlock({ children, language }: { children: ReactNode; language: string }) {
  return (
    <div className="relative my-4 overflow-hidden rounded-xl bg-black/25 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <span className="caption-style text-faint absolute top-2.5 right-3 font-mono">{language}</span>
      <pre className="text-soft overflow-x-auto px-4 py-3.5 font-mono text-[13.5px] leading-[1.65]">{children}</pre>
    </div>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <strong className="text-foreground font-semibold">{children}</strong>;
}

export function WikiLink({ children, active, broken }: { children: ReactNode; active?: boolean; broken?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      {active && <span className={noteType.marker}>[[</span>}
      <a
        href="#"
        className={cn(
          "text-foreground font-medium underline decoration-1 underline-offset-[3.5px] transition-colors duration-150",
          broken ? "decoration-dashed decoration-white/30" : "decoration-[#8b7bff]/70 hover:decoration-[#8b7bff]",
        )}
      >
        {children}
      </a>
      {active && <span className={noteType.marker}>]]</span>}
    </span>
  );
}

export function Tag({ path }: { path: string }) {
  return (
    <a href="#" className="text-soft hover:text-foreground rounded-[5px] bg-white/[0.06] px-[5px] py-[1px] text-[15px] whitespace-nowrap transition-colors duration-150">
      <span className="text-faint">#</span>
      {path}
    </a>
  );
}

export function Mention({ name, kind }: { name: string; kind: "company" | "contact" | "deal" }) {
  const Icon = kind === "company" ? BuildingIcon : kind === "deal" ? ClipboardIcon : null;
  return (
    <a
      href="#"
      title={kind === "company" ? "Company" : kind === "deal" ? "Opportunity" : "Contact"}
      className="inline-flex translate-y-[-1px] items-center gap-1 rounded-[5px] bg-(--tag-purple-bg) px-[5px] align-middle text-[15px] leading-[1.45] whitespace-nowrap text-(--tag-purple-text) shadow-[inset_0_0_0_1px_var(--tag-purple-border)] transition-colors duration-150 hover:bg-[#2b2650]"
    >
      {Icon ? (
        <Icon aria-hidden className="size-3 shrink-0 opacity-80" />
      ) : (
        <span aria-hidden className="flex size-[13px] shrink-0 items-center justify-center rounded-full bg-[#4b437b] text-[7.5px] font-semibold text-white">
          {name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)}
        </span>
      )}
      {name}
    </a>
  );
}

export function Caret() {
  return (
    <span aria-hidden className="relative inline-block w-0">
      <span className="bg-foreground absolute -top-[17px] left-[-1px] h-[22px] w-[2px] rounded-full" />
    </span>
  );
}

export function Ins({ children, block }: { children: ReactNode; block?: boolean }) {
  return (
    <ins
      className={cn(
        "rounded-[3px] bg-[color-mix(in_srgb,var(--success)_17%,transparent)] box-decoration-clone px-[1px] text-[#c9f5d8] no-underline",
        block && "block px-2",
      )}
    >
      {children}
    </ins>
  );
}

export function Del({ children }: { children: ReactNode }) {
  return (
    <del className="text-danger/80 decoration-danger/60 rounded-[3px] bg-[color-mix(in_srgb,var(--danger)_13%,transparent)] box-decoration-clone px-[1px]">
      {children}
    </del>
  );
}
