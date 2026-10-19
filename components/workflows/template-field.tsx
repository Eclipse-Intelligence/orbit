"use client";

import { useRef } from "react";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Input } from "@/components/_ui/input";
import type { VariableOption } from "@/lib/workflows/variables";
import { cn } from "@/lib/utils";

export const textareaClass =
  "flex w-full rounded-lg border border-line-strong bg-secondary px-3 py-2 text-[14px] leading-5 text-foreground outline-none transition-[border-color] duration-150 ease-power3-out placeholder:text-subtle focus-visible:border-ring";

export default function TemplateField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  rows,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: VariableOption[];
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const groups = [...new Set(options.map((option) => option.group))];

  function insert(path: string) {
    const token = `{{${path}}}`;
    const node = ref.current;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="caption-style text-subtle">
          {label}
        </label>
        {options.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-2" aria-label={`Insert a field into ${label}`}>
                Insert field
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {groups.map((group) => (
                <div key={group}>
                  <DropdownMenuLabel>{group}</DropdownMenuLabel>
                  {options
                    .filter((option) => option.group === group)
                    .map((option) => (
                      <DropdownMenuItem key={option.path} onSelect={() => insert(option.path)}>
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <span className="truncate">{option.label}</span>
                          <span className="text-subtle truncate font-mono text-[11px]">{option.path}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {rows ? (
        <textarea
          id={id}
          ref={ref}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn(textareaClass, "resize-y")}
        />
      ) : (
        <Input id={id} ref={ref} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && <span className="caption-style text-subtle">{hint}</span>}
    </div>
  );
}
