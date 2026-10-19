"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import RecordCombobox from "@/components/crm/record-combobox";
import type { PickedRecord } from "@/components/crm/record-picker";
import { addOpportunityInlineAction } from "@/app/(crm)/records";
import type { Board, PipelineStage } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const FIELD_CLASS =
  "border-line-strong bg-secondary text-foreground placeholder:text-subtle focus-visible:border-ring flex h-9 w-full min-w-0 rounded-lg border px-3 text-[14px] leading-none outline-none";

export default function OpportunityComposer({
  id,
  board,
  stages,
  stageId,
  layout,
  autoFocus,
  onClose,
}: {
  id: string;
  board: Board | null;
  stages: PipelineStage[];
  stageId?: string;
  layout: "card" | "row";
  autoFocus?: boolean;
  onClose?: () => void;
}) {
  const router = useRouter();
  const openStages = stages.filter((stage) => !stage.isWon && !stage.isLost);
  const [company, setCompany] = useState<PickedRecord | null>(null);
  const [contact, setContact] = useState<PickedRecord | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [chosenStage, setChosenStage] = useState(stageId ?? openStages[0]?.id ?? stages[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const companyInput = useRef<HTMLInputElement>(null);
  const contactInput = useRef<HTMLInputElement>(null);
  const empty = !company && !contact && !name && !value;

  useEffect(() => {
    if (!autoFocus) return;
    companyInput.current?.focus({ preventScroll: true });
    const list = root.current?.closest<HTMLElement>("[data-stage-cards]");
    if (list && root.current) list.scrollTop += root.current.getBoundingClientRect().top - list.getBoundingClientRect().top - 8;
  }, [autoFocus]);

  useEffect(() => {
    if (layout !== "card" || !onClose) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (root.current?.contains(target) || target.closest("[data-slot=popover-content]")) return;
      if (empty) onClose?.();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [empty, layout, onClose]);

  function chooseCompany(next: PickedRecord | null) {
    setCompany(next);
    setError(null);
    if (contact && contact.company?.id !== next?.id) setContact(null);
    window.requestAnimationFrame(() => (next ? contactInput.current : companyInput.current)?.focus({ preventScroll: true }));
  }

  function chooseContact(next: PickedRecord | null) {
    setContact(next);
    setError(null);
    if (next?.company && next.company.id !== company?.id) setCompany(next.company);
    if (!next) window.requestAnimationFrame(() => contactInput.current?.focus({ preventScroll: true }));
  }

  async function submit() {
    if (pending) return;
    if (!company) {
      setError("Choose a company first.");
      companyInput.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    const result = await addOpportunityInlineAction({
      companyId: company.id,
      pipelineId: board?.id ?? null,
      stageId: chosenStage || null,
      primaryContactId: contact?.id ?? null,
      ...(board ? {} : { name: name.trim() || company.name, value }),
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setStatus(`${board ? company.name : name.trim() || company.name} added`);
    setCompany(null);
    setContact(null);
    setName("");
    setValue("");
    router.refresh();
    window.requestAnimationFrame(() => companyInput.current?.focus({ preventScroll: true }));
  }

  function cancel() {
    setCompany(null);
    setContact(null);
    setName("");
    setValue("");
    setError(null);
    if (onClose) onClose();
    else companyInput.current?.blur();
  }

  const companyField = (
    <RecordCombobox
      id={`${id}-company`}
      kind="company"
      label={board ? `Add a company to ${board.name}` : "Company for a new opportunity"}
      placeholder={board ? "Add a company…" : "New opportunity: choose a company…"}
      value={company}
      onChange={chooseCompany}
      allowCreate
      inputRef={companyInput}
      onSubmit={submit}
      onCancel={cancel}
      className={layout === "row" ? "min-w-0 md:w-[18em] md:flex-none" : "min-w-0"}
    />
  );

  const details = company && (
    <>
      <RecordCombobox
        id={`${id}-contact`}
        kind="contact"
        label={board ? "Main contact" : "Primary contact"}
        placeholder={`Contact at ${company.name} (optional)`}
        value={contact}
        onChange={chooseContact}
        companyId={company.id}
        companyName={company.name}
        allowCreate
        inputRef={contactInput}
        onSubmit={submit}
        onCancel={cancel}
        className={layout === "row" ? "min-w-0 md:w-[16em] md:flex-none" : "min-w-0"}
      />
      {!board && (
        <>
          <input
            aria-label="Opportunity name"
            placeholder={company.name}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") cancel();
            }}
            className={cn(FIELD_CLASS, layout === "row" && "md:w-[12em] md:flex-none")}
          />
          <input
            aria-label="Value"
            placeholder="Value"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") cancel();
            }}
            className={cn(FIELD_CLASS, layout === "row" && "md:w-[7em] md:flex-none")}
          />
        </>
      )}
      {layout === "row" && (
        <select
          aria-label="Stage"
          value={chosenStage}
          onChange={(event) => setChosenStage(event.target.value)}
          className={cn(FIELD_CLASS, "md:w-[11em] md:flex-none")}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      )}
    </>
  );

  return (
    <div
      ref={root}
      className={cn(
        "flex flex-col gap-2",
        layout === "card" ? "border-line-strong bg-card shrink-0 rounded-lg border p-2" : "border-border border-b px-2.5 py-2.5",
      )}
    >
      <div className={cn("flex gap-2", layout === "row" ? "flex-col md:flex-row md:items-start" : "flex-col")}>
        {layout === "row" && (
          <span aria-hidden className="text-subtle hidden h-9 w-5 shrink-0 items-center justify-center md:flex">
            <PlusIcon className="size-3.5" />
          </span>
        )}
        {companyField}
        {details}
        {(company || layout === "card") && (
          <div className="flex items-center gap-1.5">
            <Button variant="primary" size="sm" disabled={pending || !company} onClick={() => void submit()}>
              {pending ? "Adding…" : "Add"}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              {layout === "card" ? "Close" : "Clear"}
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
      {layout === "card" && !company && !error && (
        <p className="caption-style text-subtle">Type to find or add a company. Esc to close.</p>
      )}
    </div>
  );
}
