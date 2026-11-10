"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { AiMark } from "@/components/ai-fields/ai-cells";
import { checkFieldAgainAction, setAiFieldHiddenAction } from "@/app/(crm)/ai-fields";
import type { AiField } from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export function AiColumnHeader({
  field,
  direction,
  canManage,
  onSort,
  onFilter,
  onEdit,
  onAdd,
  onError,
  onNotice,
}: {
  field: AiField;
  direction: "asc" | "desc" | null;
  canManage: boolean;
  onSort: (order: "asc" | "desc") => void;
  onFilter: () => void;
  onEdit: () => void;
  onAdd: () => void;
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useHeldChecking();
  const [, start] = useTransition();

  function run(action: () => Promise<{ ok: true } | { error: string }>, done?: () => void) {
    onError(null);
    start(async () => {
      const result = await action();
      if ("error" in result) onError(result.error);
      else done?.();
      router.refresh();
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${field.label}, AI field${direction ? `, sorted ${direction === "asc" ? "low to high" : "high to low"}` : ""}. ${canManage ? "Sort, filter or edit" : "Sort, filter or hide"}`}
          className={cn(
            "group/sort -mx-1 -my-0.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 whitespace-nowrap transition-colors duration-150 ease-power3-out outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            (direction || open) && "text-foreground",
            open && "bg-white/6",
          )}
        >
          <AiMark />
          {field.label}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-[transform,opacity] duration-200 ease-power3-out",
              direction === "asc" && "rotate-180",
              !direction && "opacity-35 group-hover/sort:opacity-80",
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(240px,calc(100vw-2rem))]">
        <DropdownMenuLabel className="leading-[1.4] font-normal whitespace-normal">{field.question}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSort("desc")}>Sort high to low</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSort("asc")}>Sort low to high</DropdownMenuItem>
        <DropdownMenuItem onSelect={onFilter}>Filter…</DropdownMenuItem>
        <DropdownMenuSeparator />
        {canManage && (
          <>
            <DropdownMenuItem onSelect={onEdit}>Edit field</DropdownMenuItem>
            <DropdownMenuItem
              disabled={checking}
              onSelect={() => {
                setChecking(true);
                run(
                  () => checkFieldAgainAction(field.id),
                  () => onNotice(`Checking ${field.label} for every company.`),
                );
              }}
            >
              {checking ? "Checking…" : "Check all again"}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => run(() => setAiFieldHiddenAction(field.id, true), () => onNotice(`Hid ${field.label}. Show it again with +.`))}>
          Hide column
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAdd}>
              <PlusIcon aria-hidden className="size-3" />
              Add AI field
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const HELD_MS = 90_000;

export function useHeldChecking() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(false), HELD_MS);
    return () => window.clearTimeout(timer);
  }, [held]);
  return [held, setHeld] as const;
}

export function AddColumnMenu({ canManage, hidden, onAdd, onError }: { canManage: boolean; hidden: AiField[]; onAdd: () => void; onError: (message: string | null) => void }) {
  const router = useRouter();
  const [, start] = useTransition();
  if (!canManage && hidden.length === 0) return null;
  if (hidden.length === 0) {
    return (
      <Button variant="ghost" size="icon-sm" aria-label="Add column" title="Add column" onClick={onAdd}>
        <PlusIcon aria-hidden className="size-3" />
      </Button>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={canManage ? "Add column" : "Show hidden columns"} title={canManage ? "Add column" : "Show hidden columns"}>
          <PlusIcon aria-hidden className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {canManage && (
          <>
            <DropdownMenuItem onSelect={onAdd}>
              <PlusIcon aria-hidden className="size-3" />
              Add AI field
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Hidden columns</DropdownMenuLabel>
        {hidden.map((field) => (
          <DropdownMenuItem
            key={field.id}
            onSelect={() => {
              onError(null);
              start(async () => {
                const result = await setAiFieldHiddenAction(field.id, false);
                if ("error" in result) onError(result.error);
                router.refresh();
              });
            }}
          >
            Show {field.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
