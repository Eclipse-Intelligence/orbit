"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { addAttachmentToKnowledgeAction } from "@/app/(crm)/knowledge";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import BookIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";

type Attachment = { id: string; name: string; contentType: string | null; size: number };
type Company = { id: string; name: string };
type Saved = { key: string; text: string; failed: boolean };

const READABLE = /\.(pdf|docx|pptx|xlsx|txt|md|csv|tsv|html?|json|vtt|srt)$/i;

function readable(item: Attachment) {
  return READABLE.test(item.name) || /^(application\/pdf|text\/)/i.test(item.contentType ?? "");
}

const loaded = new Map<string, Promise<Attachment[]>>();

function load(messageId: string) {
  const hit = loaded.get(messageId);
  if (hit) return hit;
  const request = fetch(`/api/mail/attachments?message=${encodeURIComponent(messageId)}`, { cache: "no-store" })
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as { attachments?: Attachment[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Attachments didn't load.");
      return body.attachments ?? [];
    })
    .catch((error) => {
      loaded.delete(messageId);
      throw error;
    });
  loaded.set(messageId, request);
  return request;
}

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MessageAttachments({ messageId, companies = [] }: { messageId: string; companies?: Company[] }) {
  const [state, setState] = useState<{ id: string; items: Attachment[] | null; error: string | null } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  async function addToKnowledge(item: Attachment, target: { companyId: string } | { eclipse: true }, place: string) {
    const key = `${messageId}|${item.id}`;
    setSaving(key);
    setSaved(null);
    const result = await addAttachmentToKnowledgeAction(messageId, item.id, target);
    setSaving(null);
    if (result.error) setSaved({ key, text: result.error, failed: true });
    else setSaved({ key, text: result.added ? `Added to ${place} Knowledge.` : `Already in ${place} Knowledge.`, failed: false });
  }

  useEffect(() => {
    let live = true;
    load(messageId)
      .then((items) => live && setState({ id: messageId, items, error: null }))
      .catch((error: Error) => live && setState({ id: messageId, items: null, error: error.message }));
    return () => {
      live = false;
    };
  }, [messageId]);

  const current = state?.id === messageId ? state : null;
  if (!current) {
    return (
      <p className="caption-style text-subtle flex items-center gap-1.5">
        <PaperclipIcon aria-hidden className="size-3" />
        Loading attachments…
      </p>
    );
  }
  if (current.error) {
    return (
      <p role="alert" className="caption-style text-danger">
        {current.error}
      </p>
    );
  }
  if (!current.items?.length) return null;
  const status = saved?.key.startsWith(`${messageId}|`) ? saved : null;
  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
        {current.items.map((item) => (
          <li key={item.id} className="flex items-center gap-0.5">
            <a
              href={`/api/mail/attachment?message=${encodeURIComponent(messageId)}&id=${encodeURIComponent(item.id)}`}
              target="_blank"
              rel="noreferrer"
              className="ease-power3-out bg-white/[0.05] hover:bg-white/[0.08] text-foreground flex h-8 max-w-[18rem] items-center gap-2 rounded-full pr-3 pl-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <PaperclipIcon aria-hidden className="text-subtle size-3 shrink-0" />
              <span className="min-w-0 truncate">{item.name}</span>
              <span className="caption-style text-subtle shrink-0">{size(item.size)}</span>
            </a>
            {readable(item) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Add ${item.name} to Knowledge`} title="Add to Knowledge" disabled={saving === `${messageId}|${item.id}`} className="size-8">
                    <BookIcon aria-hidden className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel className="caption-style text-subtle px-2 py-1.5 font-normal">Add to Knowledge</DropdownMenuLabel>
                  {companies.map((company) => (
                    <DropdownMenuItem key={company.id} onSelect={() => void addToKnowledge(item, { companyId: company.id }, company.name)}>
                      <span className="truncate">{company.name}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => void addToKnowledge(item, { eclipse: true }, "Eclipse")}>Eclipse</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
      {saving?.startsWith(`${messageId}|`) && (
        <p role="status" className="caption-style text-subtle">
          Adding to Knowledge…
        </p>
      )}
      {status && (
        <p role={status.failed ? "alert" : "status"} className={status.failed ? "caption-style text-danger" : "caption-style text-subtle"}>
          {status.text}
        </p>
      )}
    </div>
  );
}
