"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { inputClass, selectClass } from "@/components/_ui/field-styles";
import { cn } from "@/lib/utils";

export type InlineOption = { value: string; label: string };

export default function InlineField({
  label,
  value,
  display,
  type = "text",
  options,
  placeholder,
  emptyLabel = "Add",
  accessory,
  onSave,
}: {
  label: string;
  value: string;
  display?: ReactNode;
  type?: "text" | "number" | "date" | "select";
  options?: InlineOption[];
  placeholder?: string;
  emptyLabel?: string;
  accessory?: ReactNode;
  onSave: (value: string) => Promise<string | null>;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const closed = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = shown ?? value;

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  function cancel() {
    closed.current = true;
    setEditing(false);
  }

  function open() {
    closed.current = false;
    setDraft(current);
    setError(null);
    setEditing(true);
  }

  async function commit(next: string) {
    if (closed.current) return;
    closed.current = true;
    setEditing(false);
    if (next === current) return;
    setShown(next);
    setSaving(true);
    const problem = await onSave(next);
    setSaving(false);
    if (problem) {
      setShown(null);
      setError(problem);
      return;
    }
    setShown(null);
  }

  const optionLabel = options?.find((option) => option.value === current)?.label;
  const visible = shown !== null ? (optionLabel ?? shown) : (display ?? optionLabel ?? value);

  return (
    <>
      <dt className="caption-style text-subtle flex min-h-8 items-center">
        <label htmlFor={id}>{label}</label>
      </dt>
      <dd className="min-w-0">
        {editing ? (
          type === "select" ? (
            <select
              ref={field}
              id={id}
              value={draft}
              onChange={(event) => void commit(event.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => event.key === "Escape" && cancel()}
              className={cn(selectClass, "h-8")}
            >
              {options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              ref={field}
              id={id}
              type={type}
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit(draft.trim())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit(draft.trim());
                }
                if (event.key === "Escape") cancel();
              }}
              className={cn(inputClass, "h-8")}
            />
          )
        ) : (
          <span className="flex min-w-0 items-center gap-1">
          <button
            id={id}
            type="button"
            onClick={open}
            aria-label={`${label}: ${current ? String(optionLabel ?? current) : "not set"}. Edit`}
            className={cn(
              "hover:bg-white/5 focus-visible:ring-ring/60 -mx-2 flex min-h-8 min-w-0 flex-1 cursor-text items-center rounded-md px-2 text-left text-[14px] leading-5 outline-none transition-colors duration-150 focus-visible:ring-2",
              saving && "opacity-70",
            )}
          >
            {current ? <span className="min-w-0 break-words">{visible}</span> : <span className="text-subtle">{emptyLabel}</span>}
          </button>
          {accessory}
          </span>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger mt-1">
            {error}
          </p>
        )}
      </dd>
    </>
  );
}
