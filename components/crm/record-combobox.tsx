"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/_ui/popover";
import { Monogram } from "@/components/beautifui/record-marks";
import { RecordChip, searchRecords, type PickedRecord, type RecordOption } from "@/components/crm/record-picker";
import { addCompanyInlineAction, addContactInlineAction } from "@/app/(crm)/records";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type Choice = { key: string; option: RecordOption } | { key: string; create: string };

export default function RecordCombobox({
  id,
  kind,
  label,
  placeholder,
  value,
  onChange,
  companyId,
  companyName,
  allowCreate,
  autoFocus,
  inputRef,
  onSubmit,
  onCancel,
  className,
}: {
  id: string;
  kind: "company" | "contact";
  label: string;
  placeholder: string;
  value: PickedRecord | null;
  onChange: (value: PickedRecord | null) => void;
  companyId?: string | null;
  companyName?: string | null;
  allowCreate?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onSubmit?: () => void;
  onCancel?: () => void;
  className?: string;
}) {
  const listId = useId();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<{ scope: string; query: string; options: RecordOption[] } | null>(null);
  const pendingPick = useRef(false);
  const chooseRef = useRef<(choice: Choice) => Promise<void>>(async () => undefined);
  const [highlight, setHighlight] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = text.trim();
  const scope = `${kind}:${companyId ?? ""}`;
  const current = results?.scope === scope ? results.options : null;
  const canCreate = Boolean(allowCreate && query && (kind === "company" || companyId));
  const exact = current?.some((option) => option.name.toLowerCase() === query.toLowerCase());
  const choices: Choice[] = [
    ...(current ?? []).map((option) => ({ key: option.id, option })),
    ...(canCreate && current && !exact ? [{ key: "create", create: query }] : []),
  ];
  const fresh = results?.scope === scope && results.query === query;
  const open = focused && !value && current !== null && (choices.length > 0 || Boolean(query));

  useEffect(() => {
    if (!focused || value) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchRecords(kind, query, kind === "contact" ? companyId : undefined).then(
        (options) => {
          if (cancelled) return;
          setResults({ scope, query, options });
          setHighlight(0);
          if (!pendingPick.current) return;
          pendingPick.current = false;
          const match = options.find((option) => option.name.toLowerCase() === query.toLowerCase()) ?? options[0];
          if (match) void chooseRef.current({ key: match.id, option: match });
          else if (allowCreate && query && (kind === "company" || companyId)) void chooseRef.current({ key: "create", create: query });
        },
        () => {
          if (!cancelled) setResults({ scope, query, options: [] });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allowCreate, companyId, focused, kind, query, scope, value]);

  useEffect(() => {
    chooseRef.current = choose;
  });

  async function choose(choice: Choice) {
    setError(null);
    if ("option" in choice) {
      setText("");
      setNavigated(false);
      onChange({ id: choice.option.id, name: choice.option.name, company: choice.option.company ?? null });
      return;
    }
    setCreating(true);
    const result =
      kind === "company"
        ? await addCompanyInlineAction({ name: choice.create }).then((done) => ({ record: done.company, error: done.error }))
        : await addContactInlineAction({ name: choice.create, companyId }).then((done) => ({ record: done.contact, error: done.error }));
    setCreating(false);
    if (!result.record) {
      setError(result.error ?? "That did not work. Try again.");
      return;
    }
    setText("");
    setNavigated(false);
    onChange(result.record);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!choices.length) return;
      event.preventDefault();
      setNavigated(true);
      setHighlight((index) => (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (query && !fresh) {
        pendingPick.current = true;
        return;
      }
      if (open && choices.length && (query || navigated)) {
        void choose(choices[Math.min(highlight, choices.length - 1)]);
        return;
      }
      onSubmit?.();
      return;
    }
    if (event.key === "Tab" && open && query && choices.length && !event.shiftKey) {
      event.preventDefault();
      void choose(choices[Math.min(highlight, choices.length - 1)]);
      return;
    }
    if (event.key === "Escape") {
      if (query || navigated) {
        event.preventDefault();
        event.stopPropagation();
        setText("");
        setNavigated(false);
        return;
      }
      if (onCancel) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }
  }

  if (value) {
    return (
      <div className={cn("flex min-h-9 items-center", className)}>
        <RecordChip name={value.name} removeLabel={`Remove ${value.name}`} onRemove={() => onChange(null)} />
      </div>
    );
  }

  const active = open ? choices[Math.min(highlight, choices.length - 1)] : undefined;

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${listId}-${active.key}` : undefined}
            autoComplete="off"
            autoFocus={autoFocus}
            value={text}
            disabled={creating}
            placeholder={placeholder}
            onChange={(event) => {
              setText(event.target.value);
              setNavigated(false);
              pendingPick.current = false;
              setError(null);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            className="border-line-strong bg-secondary text-foreground placeholder:text-subtle focus-visible:border-ring flex h-9 w-full min-w-0 rounded-lg border px-3 text-[14px] leading-none outline-none disabled:opacity-60"
          />
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) min-w-[240px] p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ul id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
          {choices.length === 0 && (
            <li className="caption-style text-subtle px-2.5 py-4 text-center">
              {kind === "contact" && companyId ? `No one at ${companyName ?? "this company"} matches.` : "No matches."}
            </li>
          )}
          {choices.map((choice, index) => (
            <li key={choice.key} id={`${listId}-${choice.key}`} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => void choose(choice)}
                className={cn(
                  "flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
                  index === highlight ? "bg-white/[0.07]" : "hover:bg-white/5",
                )}
              >
                {"option" in choice ? (
                  <>
                    <Monogram name={choice.option.name} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-foreground truncate text-[13.5px] leading-5">{choice.option.name}</span>
                      {choice.option.detail && <span className="caption-style text-subtle truncate">{choice.option.detail}</span>}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="bg-secondary grid size-6 shrink-0 place-items-center rounded-md">
                      <PlusIcon aria-hidden className="size-3" />
                    </span>
                    <span className="text-foreground min-w-0 flex-1 truncate text-[13.5px] leading-5">
                      {kind === "company"
                        ? `Add “${choice.create}” as a new company`
                        : `Add “${choice.create}” at ${companyName ?? "this company"}`}
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
