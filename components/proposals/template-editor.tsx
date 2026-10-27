"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import SectionHeader from "@/components/crm/section-header";
import { recordSelectClass } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { ProposalLogo } from "@/components/proposals/proposal-document";
import ProposalSite from "@/components/proposals/proposal-site";
import { createTemplateAction, saveTemplateAction } from "@/app/(crm)/proposals/actions";
import { BlockEditor, type KnowledgeOption } from "@/components/proposals/block-editor";
import type { Template } from "@/lib/proposals/catalogue";
import {
  consentText,
  fieldValues,
  KIND_LABELS,
  LOGO_MAX_LENGTH,
  renderBlocks,
  totalsOf,
  type Block,
  type Content,
  type Item,
  type TemplateStatus,
} from "@/lib/proposals/model";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import { cn } from "@/lib/utils";

const SAMPLE_ITEMS: Item[] = [
  { productId: null, name: "Agency Pilot", description: "Three months of work, with weekly reporting.", billing: "one_off", unitPrice: 2500, quantity: 1 },
  { productId: null, name: "Pro", description: "Ongoing monitoring.", billing: "monthly", unitPrice: 900, quantity: 1 },
];

async function logoPng(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const vector = file.type === "image/svg+xml";
    const width = image.naturalWidth || 800;
    const height = image.naturalHeight || 240;
    const scale = Math.min(vector ? Infinity : 1, 800 / width, 240 / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function LogoField({ logo, company, onChange }: { logo: string | null; company: string; onChange: (logo: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file) return;
    setError(null);
    try {
      const png = await logoPng(file);
      if (png.length > LOGO_MAX_LENGTH) {
        setError("That logo is too detailed to use. Try a simpler or smaller image.");
        return;
      }
      onChange(png);
    } catch {
      setError("That file couldn't be read as an image. Use a PNG, JPEG or SVG.");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="template-logo" className="caption-style text-subtle">
        Logo
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-14 w-44 items-center rounded-lg bg-white px-3 shadow-[0_0_0_1px_var(--input)]">
          {logo ? <ProposalLogo src={logo} company={company} className="h-9 w-full" /> : <span className="caption-style text-[#6b6b6b]">No logo yet</span>}
        </span>
        <input
          ref={input}
          id="template-logo"
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="sr-only"
          onChange={(event) => void pick(event.target.files?.[0])}
        />
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          {logo ? "Change" : "Upload logo"}
        </Button>
        {logo && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      <p className="caption-style text-subtle leading-[1.4]">Shown at the top of the client&apos;s page and the PDF. A PNG or SVG made for a white background works best.</p>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function samplePreview(template: { kind: Template["kind"]; blocks: Block[]; accent: string; logo: string | null; validDays: number }, viewer: Viewer, now: number): Content {
  const validUntil = new Date(now + template.validDays * 86_400_000).toISOString().slice(0, 10);
  const items = template.kind === "proposal" ? SAMPLE_ITEMS : [];
  const values = fieldValues({
    company: { name: "Acme Ltd", domain: "acme.com", website: "https://acme.com" },
    contact: { name: "Jane Doe", firstName: "Jane", lastName: "Doe", jobTitle: "Operations Director", email: "jane@acme.com" },
    sender: { name: viewer.name, email: viewer.email },
    workspace: { name: viewer.workspaceName },
    proposal: { title: template.kind === "nda" ? "NDA with Acme Ltd" : "Proposal for Acme Ltd", currency: "GBP", validUntil, items },
  });
  return {
    kind: template.kind,
    title: template.kind === "nda" ? "NDA with Acme Ltd" : "Proposal for Acme Ltd",
    currency: "GBP",
    validUntil,
    accent: template.accent,
    logo: template.logo,
    client: { name: "Jane Doe", email: "jane@acme.com", title: "Operations Director", company: "Acme Ltd" },
    sender: { name: viewer.name, email: viewer.email, title: null, company: viewer.workspaceName },
    blocks: renderBlocks(template.blocks, values).blocks,
    items,
    totals: totalsOf(items),
    consent: consentText(template.kind, viewer.workspaceName, template.blocks.some((block) => block.type === "terms")),
    issuedAt: new Date(now).toISOString(),
  };
}

export default function TemplateEditor({ viewer, template, knowledge = [] }: { viewer: Viewer; template: Template; knowledge?: KnowledgeOption[] }) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [status, setStatus] = useState<TemplateStatus>(template.status);
  const [blocks, setBlocks] = useState(template.blocks);
  const [accent, setAccent] = useState(template.settings.accent);
  const [logo, setLogo] = useState(template.settings.logo);
  const [validDays, setValidDays] = useState(String(template.settings.validDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "status" | "alert" } | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [now] = useState(() => Date.now());
  const preview = samplePreview({ kind: template.kind, blocks, accent, logo, validDays: Number(validDays) || 30 }, viewer, now);

  async function save(nextStatus = status) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveTemplateAction(template.id, { name, status: nextStatus, blocks, settings: { accent, logo, validDays: Number(validDays) || 30 } });
      if (!result.data) {
        setMessage({ text: result.error ?? "That didn't save.", tone: "alert" });
        return false;
      }
      setStatus(result.data.status);
      setMessage({ text: nextStatus === "active" ? `Saved and active. It can now be used for ${template.kind === "nda" ? "NDAs" : "proposals"}.` : "Saved.", tone: "status" });
      router.refresh();
      return true;
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "That didn't save. Try again.", tone: "alert" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    setMessage(null);
    try {
      const result = await createTemplateAction({ copyOf: template.id });
      if (result.data) router.push(`/proposals/templates/${result.data.id}`);
      else setMessage({ text: result.error ?? "Couldn't copy it.", tone: "alert" });
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setMessage({ text: "Couldn't copy it. Try again.", tone: "alert" });
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={name || "Template"}
        viewer={viewer}
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void duplicate()}>
              Duplicate
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />
      {message && (
        <p role={message.tone} className={cn("caption-style px-4 pt-3", message.tone === "alert" ? "text-danger" : "text-subtle")}>
          {message.text}
        </p>
      )}
      <div className="flex gap-1 px-4 pt-3 lg:hidden" role="group" aria-label="View">
        {(["edit", "preview"] as const).map((item) => (
          <Button key={item} variant={view === item ? "secondary" : "ghost"} size="sm" aria-pressed={view === item} onClick={() => setView(item)}>
            {item === "edit" ? "Edit" : "Preview"}
          </Button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className={cn("border-border min-h-0 overflow-y-auto border-r px-4 py-5 pb-24", view === "preview" && "hidden lg:block")}>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="template-name" className="caption-style text-subtle">
                Name
              </label>
              <Input id="template-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="template-status" className="caption-style text-subtle">
                  Status
                </label>
                <select
                  id="template-status"
                  value={status}
                  onChange={(event) => {
                    const previous = status;
                    const next = event.target.value as TemplateStatus;
                    setStatus(next);
                    void save(next).then((saved) => {
                      if (!saved) setStatus((current) => (current === next ? previous : current));
                    });
                  }}
                  className={recordSelectClass}
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="template-accent" className="caption-style text-subtle">
                  Colour
                </label>
                <input
                  id="template-accent"
                  type="color"
                  value={accent}
                  onChange={(event) => setAccent(event.target.value)}
                  className="h-9 w-full cursor-pointer rounded-lg bg-transparent shadow-[0_0_0_1px_var(--input)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="template-days" className="caption-style text-subtle">
                  Valid for (days)
                </label>
                <Input id="template-days" type="number" min={1} max={365} value={validDays} onChange={(event) => setValidDays(event.target.value)} />
              </div>
            </div>
            <LogoField logo={logo} company={viewer.workspaceName} onChange={setLogo} />
            <p className="caption-style text-subtle">
              {KIND_LABELS[template.kind]} template. Only active templates can be used to create and send.
              {template.kind === "nda" ? " Have a solicitor check the wording before you rely on it." : ""}
            </p>
            <BlockEditor blocks={blocks} onChange={setBlocks} kind={template.kind} knowledge={knowledge} />
          </div>
        </div>
        <div className={cn("min-h-0 overflow-y-auto", view === "edit" && "hidden lg:block")}>
          <div className="paper min-h-full px-5 pt-10 pb-28 sm:px-10">
            <div className="mx-auto max-w-[44em]">
              <p className="caption-style text-subtle pb-6">Preview with sample details</p>
              <ProposalSite content={preview} compact extras={{ preview: true }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
