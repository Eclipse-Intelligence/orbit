"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/_ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { LifecycleMark } from "@/components/beautifui/record-marks";
import { listLifecyclesAction } from "@/app/(crm)/actions";
import { cleanLifecycle, LIFECYCLE_MAX_LENGTH, lifecycleLabel } from "@/lib/companies";
import { LIFECYCLES, type LifecycleCount } from "@/lib/crm/types";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const BUILT_IN: LifecycleCount[] = LIFECYCLES.map((value) => ({
  value,
  label: lifecycleLabel(value),
  companies: 0,
  builtIn: true,
}));

export default function LifecyclePicker({
  value,
  onChange,
  trigger,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  trigger: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<LifecycleCount[]>(BUILT_IN);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listLifecyclesAction().then(
      (list) => {
        if (!cancelled && list.length) setOptions(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const typed = cleanLifecycle(search);
  const lower = search.trim().toLowerCase();
  const matches = options.filter((option) => !lower || option.label.toLowerCase().includes(lower));
  const exists = typed !== null && options.some((option) => option.value.toLowerCase() === typed.toLowerCase());

  function pick(next: string) {
    setOpen(false);
    setSearch("");
    if (next !== value) onChange(next);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px]">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Find or create a lifecycle"
            aria-label="Find or create a lifecycle"
            maxLength={LIFECYCLE_MAX_LENGTH}
          />
          <CommandList>
            <CommandEmpty className="py-6">Type a name for the lifecycle.</CommandEmpty>
            {matches.map((option) => (
              <CommandItem key={option.value} value={`pick:${option.value}`} onSelect={() => pick(option.value)}>
                <LifecycleMark lifecycle={option.value} />
                {option.value === value && <span className="caption-style text-subtle ml-auto">Current</span>}
              </CommandItem>
            ))}
            {typed && !exists && (
              <CommandItem value={`create:${typed}`} onSelect={() => pick(typed)}>
                <PlusIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">
                  Create <span className="text-foreground">“{typed}”</span>
                </span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
