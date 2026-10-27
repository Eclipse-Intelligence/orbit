"use client";

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Input } from "@/components/_ui/input";
import DetailSection from "@/components/companies/detail/detail-section";
import { SettingsCard } from "@/components/crm/settings-ui";
import {
  addKnowledgeLinkAction,
  finishKnowledgeUploadAction,
  listKnowledgeAction,
  prepareKnowledgeUploadAction,
  removeKnowledgeAction,
  retryKnowledgeAction,
} from "@/app/(crm)/knowledge";
import type { KnowledgeItem } from "@/lib/knowledge/store";
import { cn } from "@/lib/utils";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

export type KnowledgeTargetProp = { companyId: string } | { eclipse: true };

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 10 * 60_000;
const AUDIO_PIECE_BYTES = 10 * 1024 * 1024;
const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.html,.htm,.json,.vtt,.srt,.mp3,.m4a,.wav";

const KIND_LABEL: Record<KnowledgeItem["kind"], string> = {
  file: "File",
  link: "Link",
  youtube: "YouTube",
  podcast: "Podcast",
  transcript: "Call",
  attachment: "Email attachment",
};

type Uploading = { key: string; name: string; error: string | null };

async function upload(url: string, file: File) {
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", file);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const response = await fetch(url, { method: "PUT", body, headers: { "x-upsert": "false", ...(key ? { apikey: key } : {}) } });
  if (!response.ok) throw new Error("The upload didn't finish.");
}

function sizeLabel(bytes: number | null) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function working(item: KnowledgeItem) {
  return item.status === "indexing" || (item.status === "pending" && item.kind !== "file");
}

function statusLine(item: KnowledgeItem) {
  if (item.status === "failed") return item.error ?? "Couldn't read it.";
  if (item.status === "pending" && item.kind === "file") return "Uploading";
  if (item.status === "pending" || item.status === "indexing") return "Reading";
  return null;
}

export default function KnowledgePanel({
  target: given,
  initial,
  variant = "section",
}: {
  target: KnowledgeTargetProp;
  initial: KnowledgeItem[];
  variant?: "section" | "settings";
}) {
  const targetKey = "companyId" in given ? given.companyId : "eclipse";
  const target = useMemo<KnowledgeTargetProp>(() => (targetKey === "eclipse" ? { eclipse: true } : { companyId: targetKey }), [targetKey]);
  const [items, setItems] = useState(initial);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<KnowledgeItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [round, setRound] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const linkId = useId();
  const busy = items.some(working);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        window.clearInterval(timer);
        return;
      }
      const result = await listKnowledgeAction(target);
      if (result.items) setItems(result.items);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, round, target]);

  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  function track(item: KnowledgeItem) {
    setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
    setRound((value) => value + 1);
  }

  async function addFiles(files: File[]) {
    setError(null);
    for (const file of files) {
      const key = `upload-${(counter.current += 1)}`;
      if (file.size > MAX_BYTES) {
        setUploads((current) => [...current, { key, name: file.name, error: `${file.name} is over 50 MB.` }]);
        continue;
      }
      if (file.size > AUDIO_PIECE_BYTES && /\.(m4a|wav|aac|ogg|opus|flac)$/i.test(file.name)) {
        setUploads((current) => [...current, { key, name: file.name, error: `Audio over 10 MB has to be MP3.` }]);
        continue;
      }
      setUploads((current) => [...current, { key, name: file.name, error: null }]);
      const prepared = await prepareKnowledgeUploadAction(target, { name: file.name, size: file.size, contentType: file.type });
      if (!prepared.item || !prepared.uploadUrl) {
        setUploads((current) => current.map((entry) => (entry.key === key ? { ...entry, error: prepared.error ?? "Couldn't upload it." } : entry)));
        continue;
      }
      try {
        await upload(prepared.uploadUrl, file);
      } catch {
        await removeKnowledgeAction(prepared.item.id);
        setUploads((current) => current.map((entry) => (entry.key === key ? { ...entry, error: `${file.name} didn't finish uploading.` } : entry)));
        continue;
      }
      const finished = await finishKnowledgeUploadAction(prepared.item.id);
      setUploads((current) => current.filter((entry) => entry.key !== key));
      if (finished.item) track({ ...finished.item, status: "indexing" });
      else setError(finished.error ?? "Couldn't finish the upload.");
    }
  }

  async function addLink(event: FormEvent) {
    event.preventDefault();
    if (!link.trim() || adding) return;
    setAdding(true);
    setLinkError(null);
    const result = await addKnowledgeLinkAction(target, link);
    setAdding(false);
    if (!result.item) {
      setLinkError(result.error ?? "Couldn't add the link.");
      return;
    }
    track(result.item);
    setLink("");
    setLinkOpen(false);
  }

  async function retry(item: KnowledgeItem) {
    setError(null);
    track({ ...item, status: "indexing", error: null });
    const result = await retryKnowledgeAction(item.id);
    if (result.error) setError(result.error);
  }

  async function remove(item: KnowledgeItem) {
    setError(null);
    const before = items;
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    const result = await removeKnowledgeAction(item.id);
    if (result.error) {
      setItems(before);
      setError(result.error);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) void addFiles(files);
  }

  const settings = variant === "settings";

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => fileInput.current?.click()}>Upload files</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setLinkError(null);
            setLinkOpen(true);
          }}
        >
          Add link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const body = (
    <div
      className={cn("flex flex-col gap-3 rounded-lg transition-shadow duration-150", dragging && "shadow-[0_0_0_1px_var(--ring)]")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void addFiles(files);
        }}
      />
      {linkOpen && (
        <form onSubmit={addLink} className="flex flex-col gap-1.5">
          <label htmlFor={linkId} className="sr-only">
            Link
          </label>
          <div className="flex items-center gap-2">
            <Input
              ref={linkInput}
              id={linkId}
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setLinkOpen(false);
                  setLink("");
                }
              }}
              aria-invalid={Boolean(linkError)}
              className="min-w-0 flex-1"
            />
            <Button variant="primary" size="sm" type="submit" disabled={adding || !link.trim()}>
              {adding ? "Adding" : "Add"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLinkOpen(false);
                setLink("");
              }}
            >
              Cancel
            </Button>
          </div>
          {linkError && (
            <p role="alert" className="caption-style text-danger">
              {linkError}
            </p>
          )}
        </form>
      )}
      {items.length === 0 && uploads.length === 0 ? (
        <p className="caption-style text-subtle">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {uploads.map((entry) => (
            <li key={entry.key} className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[14px] leading-5">{entry.name}</span>
                <span role={entry.error ? "alert" : "status"} className={cn("caption-style", entry.error ? "text-danger" : "text-subtle")}>
                  {entry.error ?? "Uploading"}
                </span>
              </div>
              {entry.error && (
                <Button variant="ghost" size="sm" onClick={() => setUploads((current) => current.filter((item) => item.key !== entry.key))}>
                  Dismiss
                </Button>
              )}
            </li>
          ))}
          {items.map((item) => {
            const status = statusLine(item);
            const meta = [KIND_LABEL[item.kind], sizeLabel(item.sizeBytes), item.createdBy].filter(Boolean).join(" · ");
            return (
              <li key={item.id} className="group flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {item.sourceUrl ? (
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="truncate text-[14px] leading-5 hover:underline">
                      {item.title}
                    </a>
                  ) : (
                    <span className="truncate text-[14px] leading-5">{item.title}</span>
                  )}
                  <span className="caption-style text-subtle truncate">{meta}</span>
                  {status ? (
                    <span role={item.status === "failed" ? "alert" : "status"} className={cn("caption-style", item.status === "failed" ? "text-danger" : "text-subtle")}>
                      {status}
                    </span>
                  ) : (
                    item.summary && <p className="caption-style text-soft line-clamp-2">{item.summary}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {item.status === "failed" && (
                    <Button variant="ghost" size="sm" onClick={() => void retry(item)}>
                      Retry
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${item.title}`} onClick={() => setRemoving(item)}>
                    <TrashIcon aria-hidden className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove from Knowledge?"
        description={`The assistant will no longer use ${removing?.title ?? "it"}.`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
      />
    </div>
  );

  if (settings) {
    return (
      <SettingsCard title="Eclipse" action={addMenu}>
        {body}
      </SettingsCard>
    );
  }
  return (
    <DetailSection title={items.length ? `Knowledge · ${items.length}` : "Knowledge"} action={addMenu}>
      {body}
    </DetailSection>
  );
}
