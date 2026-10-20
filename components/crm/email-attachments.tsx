"use client";

import { useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { discardAttachmentsAction, prepareAttachmentAction } from "@/app/(crm)/capture/actions";
import { cn } from "@/lib/utils";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_COUNT = 10;

type Item = { key: string; id: string | null; name: string; size: number; status: "uploading" | "ready" | "failed"; error?: string };

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function upload(url: string, file: File) {
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", file);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const response = await fetch(url, { method: "PUT", body, headers: { "x-upsert": "false", ...(key ? { apikey: key } : {}) } });
  if (!response.ok) throw new Error("The upload didn't finish.");
}

export function useEmailAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const counter = useRef(0);

  function patch(key: string, change: Partial<Item>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }

  async function add(files: File[]) {
    const kept = items.filter((item) => item.status !== "failed");
    let total = kept.reduce((sum, item) => sum + item.size, 0);
    let count = kept.length;
    for (const file of files) {
      const key = `attachment-${(counter.current += 1)}`;
      const base = { key, id: null, name: file.name, size: file.size };
      if (count >= MAX_COUNT) {
        setItems((current) => [...current, { ...base, status: "failed", error: `Attach up to ${MAX_COUNT} files.` }]);
        continue;
      }
      if (total + file.size > MAX_BYTES) {
        setItems((current) => [...current, { ...base, status: "failed", error: "Attachments can be up to 25 MB in total." }]);
        continue;
      }
      count += 1;
      total += file.size;
      setItems((current) => [...current, { ...base, status: "uploading" }]);
      void (async () => {
        const prepared = await prepareAttachmentAction({ name: file.name, size: file.size, contentType: file.type });
        if (!prepared.attachment) {
          patch(key, { status: "failed", error: prepared.error ?? "Couldn't attach the file." });
          return;
        }
        try {
          await upload(prepared.attachment.uploadUrl, file);
          patch(key, { id: prepared.attachment.id, status: "ready" });
        } catch (error) {
          void discardAttachmentsAction([prepared.attachment.id]);
          patch(key, { status: "failed", error: error instanceof Error ? error.message : "The upload didn't finish." });
        }
      })();
    }
  }

  function remove(key: string) {
    const item = items.find((entry) => entry.key === key);
    if (item?.id) void discardAttachmentsAction([item.id]);
    setItems((current) => current.filter((entry) => entry.key !== key));
  }

  return {
    items,
    ids: items.filter((item) => item.status === "ready" && item.id).map((item) => item.id as string),
    uploading: items.some((item) => item.status === "uploading"),
    add,
    remove,
    clear: () => setItems([]),
  };
}

export function AttachButton({
  onFiles,
  disabled,
  id,
  compact,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  id: string;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        id={id}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled={disabled}
        aria-label={compact ? "Attach files" : undefined}
        title="Attach files"
        className={compact ? "size-8 p-0" : undefined}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon aria-hidden className="size-3.5" />
        {!compact && "Attach"}
      </Button>
    </>
  );
}

export function AttachmentList({ items, onRemove, disabled }: { items: Item[]; onRemove: (key: string) => void; disabled?: boolean }) {
  if (items.length === 0) return null;
  const failures = items.filter((item) => item.status === "failed" && item.error);
  return (
    <>
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "bg-secondary flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full pr-1 pl-2.5 text-[13px] leading-5",
            item.status === "failed" && "text-danger",
          )}
          title={item.error}
        >
          <PaperclipIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{item.name}</span>
          <span className="caption-style text-subtle shrink-0">
            {item.status === "uploading" ? "Uploading…" : item.status === "failed" ? "Failed" : size(item.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            disabled={disabled}
            onClick={() => onRemove(item.key)}
            className="text-subtle hover:text-foreground focus-visible:ring-ring/60 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-white/6 focus-visible:ring-2"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </li>
      ))}
    </ul>
    {failures.length > 0 && (
      <p role="alert" className="caption-style text-danger">
        {failures.map((item) => `${item.name}: ${item.error}`).join(" ")}
      </p>
    )}
    </>
  );
}
