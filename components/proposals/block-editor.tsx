"use client";

import { useRef, useState } from "react";
import Asset from "@/components/_ui/asset";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Input } from "@/components/_ui/input";
import { prepareProposalImageAction } from "@/app/(crm)/proposals/actions";
import { BLOCK_LABELS, FIELD_OPTIONS, newBlockId, type Block, type BlockType, type DocumentKind } from "@/lib/proposals/model";
import { uploadToSignedUrl } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

export type KnowledgeOption = { id: string; title: string; kind: string; group: string };

const textarea =
  "bg-transparent focus-visible:ring-ring/60 w-full rounded-lg px-3 py-2 text-[14px] leading-[1.5] shadow-[0_0_0_1px_var(--input)] outline-none focus-visible:ring-2";

const PROPOSAL_SECTIONS: BlockType[] = ["section", "pricing", "video", "image", "documents", "booking", "faq", "quote", "team", "embed", "terms", "cover"];
const NDA_SECTIONS: BlockType[] = ["section", "terms", "cover"];

function blankBlock(type: BlockType, id: string): Block {
  switch (type) {
    case "cover":
      return { id, type, title: "{{proposal.title}}", subtitle: "Prepared for {{contact.name}} at {{company.name}}.", image: "" };
    case "tab":
      return { id, type, label: "New tab" };
    case "pricing":
      return { id, type, heading: "Investment", intro: "" };
    case "terms":
      return { id, type, heading: "Terms and conditions", body: "", linkLabel: "Read our terms and conditions", linkUrl: "" };
    case "video":
      return { id, type, heading: "", url: "", caption: "" };
    case "image":
      return { id, type, url: "", caption: "" };
    case "documents":
      return { id, type, heading: "Documents", intro: "", items: [] };
    case "booking":
      return { id, type, heading: "Book a call", intro: "" };
    case "faq":
      return { id, type, heading: "Questions", items: [{ question: "", answer: "" }] };
    case "quote":
      return { id, type, quote: "", name: "", role: "" };
    case "team":
      return { id, type, heading: "Your team", people: [{ name: "{{sender.name}}", role: "", email: "{{sender.email}}", photo: "" }] };
    case "embed":
      return { id, type, heading: "", url: "", caption: "" };
    default:
      return { id, type: "section", heading: "New section", body: "" };
  }
}

export function ImageField({ id, label, value, onChange, round }: { id: string; label: string; value: string; onChange: (url: string) => void; round?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    const prepared = await prepareProposalImageAction({ name: file.name, size: file.size, contentType: file.type });
    if (!prepared.data) {
      setBusy(false);
      setError(prepared.error ?? "Couldn't upload it.");
      return;
    }
    try {
      await uploadToSignedUrl(prepared.data.uploadUrl, file);
      onChange(prepared.data.url);
    } catch {
      setError("The upload didn't finish. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="caption-style text-subtle">
        {label}
      </label>
      {value &&
        (round ? (
          <Asset type="image" src={value} alt="" width={1} height={1} fit="cover" unoptimized className="size-14 rounded-full shadow-[0_0_0_1px_var(--input)]" />
        ) : (
          <Asset type="image" src={value} alt="" width={12} height={5} fit="cover" unoptimized className="rounded-lg shadow-[0_0_0_1px_var(--input)]" />
        ))}
      <input ref={input} id={id} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(event) => void pick(event.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading" : value ? "Change" : "Upload image"}
        </Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange("")}>
            Remove
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldButtons({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <details className="caption-style text-subtle">
      <summary className="cursor-pointer select-none">Insert a field</summary>
      <div className="flex flex-wrap gap-1.5 pt-2">
        {FIELD_OPTIONS.map((option) => (
          <Button key={option.path} variant="secondary" size="sm" onClick={() => onInsert(`{{${option.path}}}`)}>
            {option.label}
          </Button>
        ))}
      </div>
    </details>
  );
}

function DocumentPicker({ block, knowledge, onChange }: { block: Extract<Block, { type: "documents" }>; knowledge: KnowledgeOption[]; onChange: (items: Extract<Block, { type: "documents" }>["items"]) => void }) {
  const chosen = new Set(block.items.map((item) => item.id));
  const groups = [...new Set(knowledge.map((item) => item.group))];
  const missing = block.items.filter((item) => !knowledge.some((option) => option.id === item.id));
  const toggle = (option: KnowledgeOption, on: boolean) => {
    if (on) onChange([...block.items, { id: option.id, title: option.title, kind: option.kind, sourceUrl: "", fingerprint: "" }]);
    else onChange(block.items.filter((item) => item.id !== option.id));
  };
  if (knowledge.length === 0 && missing.length === 0) {
    return <p className="caption-style text-subtle">Nothing in Knowledge yet. Add documents on the company page or in Settings › Knowledge.</p>;
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="caption-style text-subtle pb-1.5">Documents to share</legend>
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-1">
          <span className="caption-style text-subtle">{group}</span>
          <ul className="flex flex-col">
            {knowledge
              .filter((option) => option.group === group)
              .map((option) => (
                <li key={option.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/4">
                    <Checkbox checked={chosen.has(option.id)} onCheckedChange={(state) => toggle(option, state === true)} aria-label={option.title} />
                    <span className="ui-style min-w-0 flex-1 truncate">{option.title}</span>
                  </label>
                </li>
              ))}
          </ul>
        </div>
      ))}
      {missing.length > 0 && (
        <ul className="flex flex-col">
          {missing.map((item) => (
            <li key={item.id} className="flex min-h-9 items-center gap-3 px-2">
              <span className="ui-style min-w-0 flex-1 truncate">{item.title || "Document no longer in Knowledge"}</span>
              <Button variant="ghost" size="sm" onClick={() => onChange(block.items.filter((entry) => entry.id !== item.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

export function BlockEditor({
  blocks,
  onChange,
  kind,
  knowledge = [],
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  kind: DocumentKind;
  knowledge?: KnowledgeOption[];
}) {
  const focused = useRef<{ id: string; key: string; element: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const update = (id: string, patch: Record<string, unknown>) => onChange(blocks.map((block) => (block.id === id ? ({ ...block, ...patch } as Block) : block)));
  const move = (index: number, by: number) => {
    const next = [...blocks];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  const add = (type: BlockType) => onChange([...blocks, blankBlock(type, newBlockId(blocks.map((item) => item.id)))]);
  const insert = (token: string) => {
    const target = focused.current;
    if (!target) return;
    const block = blocks.find((item) => item.id === target.id) as Record<string, unknown> | undefined;
    if (!block) return;
    const value = String(block[target.key] ?? "");
    const start = target.element.selectionStart ?? value.length;
    const end = target.element.selectionEnd ?? value.length;
    update(target.id, { [target.key]: `${value.slice(0, start)}${token}${value.slice(end)}` });
  };
  const field = (id: string, label: string, value: string, onValue: (value: string) => void, options: { rows?: number; focusKey?: { block: string; key: string }; type?: string; placeholder?: string } = {}) => {
    const common = {
      id,
      value,
      placeholder: options.placeholder,
      onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
        focused.current = options.focusKey ? { id: options.focusKey.block, key: options.focusKey.key, element: event.currentTarget } : null;
      },
      onChange: (event: { target: { value: string } }) => onValue(event.target.value),
    };
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="caption-style text-subtle">
          {label}
        </label>
        {options.rows ? <textarea {...common} rows={options.rows} className={textarea} /> : <Input {...common} type={options.type ?? "text"} />}
      </div>
    );
  };
  const text = (block: Block, key: string, label: string, rows?: number, placeholder?: string) =>
    field(`${block.id}-${key}`, label, String((block as Record<string, unknown>)[key] ?? ""), (value) => update(block.id, { [key]: value }), {
      rows,
      placeholder,
      focusKey: { block: block.id, key },
    });
  const sections = kind === "proposal" ? PROPOSAL_SECTIONS : NDA_SECTIONS;

  return (
    <div className="flex flex-col gap-4">
      <FieldButtons onInsert={insert} />
      <ol className="flex flex-col gap-3">
        {blocks.map((block, index) => (
          <li
            key={block.id}
            className={cn(
              "flex flex-col gap-3 rounded-xl border p-4",
              block.type === "tab" ? "bg-secondary border-transparent" : "border-line-strong bg-card",
              block.type === "tab" && index > 0 && "mt-3",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="eyebrow-style text-subtle flex-1">{BLOCK_LABELS[block.type]}</span>
              <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${BLOCK_LABELS[block.type]} up`}>
                Up
              </Button>
              <Button variant="ghost" size="sm" disabled={index === blocks.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${BLOCK_LABELS[block.type]} down`}>
                Down
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onChange(blocks.filter((item) => item.id !== block.id))} aria-label={`Remove ${BLOCK_LABELS[block.type]}`}>
                Remove
              </Button>
            </div>
            {block.type === "tab" && text(block, "label", "Tab name")}
            {block.type === "cover" && (
              <>
                <ImageField id={`${block.id}-image`} label="Cover image" value={block.image} onChange={(image) => update(block.id, { image })} />
                {text(block, "title", "Title")}
                {text(block, "subtitle", "Subtitle", 2)}
              </>
            )}
            {block.type === "section" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "body", "Text", 6)}
                <p className="caption-style text-subtle">Leave a blank line between paragraphs. Start lines with - for bullets, and use **bold** or [link text](https://…).</p>
              </>
            )}
            {block.type === "pricing" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "intro", "Text above the prices", 2)}
                <p className="caption-style text-subtle">The products and totals chosen for each proposal appear here.</p>
              </>
            )}
            {block.type === "terms" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "body", "Text", 4)}
                <div className="grid gap-3 sm:grid-cols-2">
                  {text(block, "linkLabel", "Link text")}
                  {text(block, "linkUrl", "Link to your terms (https://…)")}
                </div>
              </>
            )}
            {block.type === "video" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "url", "Video link", undefined, "YouTube, Loom or Vimeo")}
                {text(block, "caption", "Caption")}
              </>
            )}
            {block.type === "image" && (
              <>
                <ImageField id={`${block.id}-url`} label="Image" value={block.url} onChange={(url) => update(block.id, { url })} />
                {text(block, "caption", "Caption")}
              </>
            )}
            {block.type === "embed" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "url", "Link", undefined, "Figma, Google Slides, Typeform, Miro, Canva…")}
                {text(block, "caption", "Caption")}
              </>
            )}
            {block.type === "documents" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "intro", "Text above the documents", 2)}
                <DocumentPicker block={block} knowledge={knowledge} onChange={(items) => update(block.id, { items })} />
              </>
            )}
            {block.type === "booking" && (
              <>
                {text(block, "heading", "Heading")}
                {text(block, "intro", "Text above the calendar", 2)}
                <p className="caption-style text-subtle">Shows the proposal owner&apos;s booking page, filled in with the client&apos;s name and email.</p>
              </>
            )}
            {block.type === "quote" && (
              <>
                {text(block, "quote", "Quote", 3)}
                <div className="grid gap-3 sm:grid-cols-2">
                  {text(block, "name", "Name")}
                  {text(block, "role", "Role and company")}
                </div>
              </>
            )}
            {block.type === "faq" && (
              <>
                {text(block, "heading", "Heading")}
                <ol className="flex flex-col gap-3">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="border-border flex flex-col gap-2 border-t pt-3">
                      {field(`${block.id}-q${itemIndex}`, `Question ${itemIndex + 1}`, item.question, (question) =>
                        update(block.id, { items: block.items.map((entry, position) => (position === itemIndex ? { ...entry, question } : entry)) }),
                      )}
                      {field(
                        `${block.id}-a${itemIndex}`,
                        "Answer",
                        item.answer,
                        (answer) => update(block.id, { items: block.items.map((entry, position) => (position === itemIndex ? { ...entry, answer } : entry)) }),
                        { rows: 3 },
                      )}
                      <Button variant="ghost" size="sm" className="self-start" onClick={() => update(block.id, { items: block.items.filter((_, position) => position !== itemIndex) })}>
                        Remove question
                      </Button>
                    </li>
                  ))}
                </ol>
                <Button variant="secondary" size="sm" className="self-start" onClick={() => update(block.id, { items: [...block.items, { question: "", answer: "" }] })}>
                  Add question
                </Button>
              </>
            )}
            {block.type === "team" && (
              <>
                {text(block, "heading", "Heading")}
                <ol className="flex flex-col gap-3">
                  {block.people.map((person, personIndex) => {
                    const set = (patch: Partial<typeof person>) =>
                      update(block.id, { people: block.people.map((entry, position) => (position === personIndex ? { ...entry, ...patch } : entry)) });
                    return (
                      <li key={personIndex} className="border-border flex flex-col gap-2 border-t pt-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          {field(`${block.id}-n${personIndex}`, "Name", person.name, (name) => set({ name }))}
                          {field(`${block.id}-r${personIndex}`, "Role", person.role, (role) => set({ role }))}
                        </div>
                        {field(`${block.id}-e${personIndex}`, "Email", person.email, (email) => set({ email }), { type: "text" })}
                        <ImageField id={`${block.id}-p${personIndex}`} label="Photo" value={person.photo} round onChange={(photo) => set({ photo })} />
                        <Button variant="ghost" size="sm" className="self-start" onClick={() => update(block.id, { people: block.people.filter((_, position) => position !== personIndex) })}>
                          Remove person
                        </Button>
                      </li>
                    );
                  })}
                </ol>
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => update(block.id, { people: [...block.people, { name: "", role: "", email: "", photo: "" }] })}
                >
                  Add person
                </Button>
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {kind === "proposal" && (
          <Button variant="secondary" size="sm" onClick={() => add("tab")}>
            Add tab
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm">
              Add section
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {sections.map((type) => (
              <DropdownMenuItem key={type} onSelect={() => add(type)}>
                {BLOCK_LABELS[type]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
