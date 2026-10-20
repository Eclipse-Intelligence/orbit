"use client";

import { useEffect, useState } from "react";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

type Attachment = { id: string; name: string; contentType: string | null; size: number };

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

export default function MessageAttachments({ messageId }: { messageId: string }) {
  const [state, setState] = useState<{ id: string; items: Attachment[] | null; error: string | null } | null>(null);

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
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {current.items.map((item) => (
        <li key={item.id}>
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
        </li>
      ))}
    </ul>
  );
}
