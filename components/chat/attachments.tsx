"use client";

import Image from "next/image";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import Asset from "@/components/_ui/asset";
import Button from "@/components/_ui/button";
import type { QueuedFile } from "@/components/chat/use-uploads";
import { chatFileHref, fileBadge, fileSize, fileTone, isChatImage, opensInline, type FileTone } from "@/lib/chat/files";
import { clockTime } from "@/lib/chat/format";
import { CHAT_FILES_MAX, CHAT_FILE_MAX_BYTES, type ChatAttachment, type ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import DownloadIcon from "@/public/assets/images/chat/download.svg";
import NextIcon from "@/public/assets/images/chat/next.svg";
import PreviousIcon from "@/public/assets/images/chat/previous.svg";
import RemoveIcon from "@/public/assets/images/chat/remove.svg";
import UploadIcon from "@/public/assets/images/chat/upload.svg";

const GRID_TILES = 3;
const SWIPE_PX = 60;
const VIEWER_FALLBACK = { width: 1600, height: 1200 };

const TONES: Record<FileTone, string> = {
  pdf: "bg-[rgb(249_115_115/0.16)] text-[#febfc6]",
  sheet: "bg-[rgb(34_197_94/0.16)] text-[#a7f3c4]",
  doc: "bg-[rgb(59_130_246/0.18)] text-[#bfdbfe]",
  other: "bg-surface-active text-soft",
};

function Badge({ name, contentType }: { name: string; contentType: string }) {
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-[7px] text-[9.5px] font-semibold", TONES[fileTone(name, contentType)])}>
      {fileBadge(name, contentType)}
    </span>
  );
}

export function FileChip({ file }: { file: ChatAttachment }) {
  const inline = opensInline(file.contentType);
  return (
    <a
      href={chatFileHref(file.id, { download: !inline })}
      target={inline ? "_blank" : undefined}
      rel={inline ? "noopener" : undefined}
      aria-label={`${inline ? "Open" : "Download"} ${file.name}, ${fileSize(file.size)}`}
      className="bg-surface-raised hover:bg-surface-active focus-visible:ring-ring/60 flex max-w-[300px] min-w-0 items-center gap-2.5 rounded-[10px] py-2 pr-3 pl-2 outline-none focus-visible:ring-2 max-md:max-w-full md:min-w-[220px]"
    >
      <Badge name={file.name} contentType={file.contentType} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ui-style truncate">{file.name}</span>
        <span className="caption-style text-subtle">{fileSize(file.size)}</span>
      </span>
      <DownloadIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
    </a>
  );
}

function tileSize(index: number, count: number) {
  if (count === 1) return "h-[140px] w-[220px] max-md:h-[120px] max-md:w-[180px]";
  return index === 0 ? "h-[140px] w-[220px] max-md:h-[120px] max-md:w-[150px]" : "size-[140px] max-md:h-[120px] max-md:w-[110px]";
}

function ImageGrid({ images, onOpen }: { images: ChatAttachment[]; onOpen: (index: number) => void }) {
  const shown = images.slice(0, GRID_TILES);
  const hidden = images.length - shown.length;
  return (
    <div className="mt-0.5 flex flex-wrap gap-1.5">
      {shown.map((image, index) => {
        const more = index === shown.length - 1 && hidden > 0;
        return (
          <button
            key={image.id}
            type="button"
            onClick={() => onOpen(index)}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            aria-label={more ? `Open ${image.name} and ${hidden} more` : `Open ${image.name}`}
            className={cn(
              "bg-surface-raised focus-visible:ring-ring/60 relative shrink-0 overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-line-strong)] outline-none focus-visible:ring-2",
              tileSize(index, shown.length),
            )}
          >
            <Asset type="image" src={chatFileHref(image.id)} alt="" width={image.width ?? 1} height={image.height ?? 1} fit="cover" loading="lazy" unoptimized className="size-full" />
            {more && <span className="absolute inset-0 grid place-items-center bg-black/55 text-[18px] font-semibold text-white">+{hidden}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ImageViewer({ message, images, index, onIndex, onClose }: { message: ChatMessage; images: ChatAttachment[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = images[index];
  const start = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Set<number>());
  const [drag, setDrag] = useState(0);
  const step = (by: number) => onIndex((index + by + images.length) % images.length);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (images.length < 2) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  }

  function zoomed() {
    return (window.visualViewport?.scale ?? 1) > 1.01;
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") return;
    pointers.current.add(event.pointerId);
    start.current = pointers.current.size === 1 && !zoomed() ? { x: event.clientX, y: event.clientY } : null;
    if (!start.current) setDrag(0);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    setDrag(Math.max(0, event.clientY - start.current.y));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    const from = start.current;
    start.current = null;
    setDrag(0);
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (dy > SWIPE_PX * 1.5 && Math.abs(dy) > Math.abs(dx)) onClose();
    else if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) && images.length > 1) step(dx < 0 ? 1 : -1);
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={keyDown}
          className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none"
        >
          <div className="flex shrink-0 items-center gap-2.5 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2.5">
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close" title="Close (Esc)" className="hit text-soft hover:text-white max-md:size-11">
                <RemoveIcon aria-hidden className="size-4" />
              </Button>
            </DialogPrimitive.Close>
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogPrimitive.Title className="ui-style truncate font-medium">{message.author.name}</DialogPrimitive.Title>
              <span className="caption-style text-subtle truncate">
                {image.name} · {clockTime(message.createdAt)}
                {images.length > 1 ? ` · ${index + 1} of ${images.length}` : ""}
              </span>
            </div>
            <a
              href={chatFileHref(image.id, { download: true })}
              aria-label={`Download ${image.name}`}
              title="Download"
              className="hit text-soft focus-visible:ring-ring/60 grid size-[30px] place-items-center rounded-lg outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 max-md:size-11"
            >
              <DownloadIcon aria-hidden className="size-4" />
            </a>
          </div>
          <div
            className="relative flex min-h-0 flex-1 touch-pinch-zoom items-center justify-center px-2 pb-[max(env(safe-area-inset-bottom),24px)] select-none"
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={(event) => {
              pointers.current.delete(event.pointerId);
              start.current = null;
              setDrag(0);
            }}
          >
            <Image
              key={image.id}
              src={chatFileHref(image.id)}
              alt={image.name}
              width={image.width ?? VIEWER_FALLBACK.width}
              height={image.height ?? VIEWER_FALLBACK.height}
              unoptimized
              draggable={false}
              style={drag ? { transform: `translateY(${drag}px)` } : undefined}
              className="h-auto max-h-full w-auto max-w-full object-contain"
            />
            {images.length > 1 && (
              <>
                <Button variant="ghost" size="icon" aria-label="Previous image" onClick={() => step(-1)} className="text-soft absolute top-1/2 left-3 size-10 -translate-y-1/2 rounded-full bg-black/40 hover:bg-white/10 hover:text-white pointer-coarse:hidden">
                  <PreviousIcon aria-hidden className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next image" onClick={() => step(1)} className="text-soft absolute top-1/2 right-3 size-10 -translate-y-1/2 rounded-full bg-black/40 hover:bg-white/10 hover:text-white pointer-coarse:hidden">
                  <NextIcon aria-hidden className="size-4" />
                </Button>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function MessageAttachments({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState<number | null>(null);
  const images = message.attachments.filter(isChatImage);
  const others = message.attachments.filter((file) => !isChatImage(file));
  if (message.attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-0.5">
      {images.length > 0 && <ImageGrid images={images} onOpen={setOpen} />}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((file) => (
            <FileChip key={file.id} file={file} />
          ))}
        </div>
      )}
      {open !== null && images[open] && <ImageViewer message={message} images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <Button
      variant="ghost"
      size="none"
      aria-label={`Remove ${name}`}
      title="Remove"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRemove}
      className="hit text-soft absolute -top-1.5 -right-1.5 size-5 rounded-full pointer-coarse:size-6 bg-[#2f2f2f] shadow-[0_0_0_2px_var(--color-secondary)] hover:bg-[#3a3a3a] hover:text-white"
    >
      <RemoveIcon aria-hidden className="size-3" />
    </Button>
  );
}

export function UploadQueue({ files, onRemove, onRetry }: { files: QueuedFile[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-3.5 pt-1.5 pb-1 pointer-coarse:gap-5 pointer-coarse:pt-3.5 pointer-coarse:pr-5">
      {files.map((file) => {
        const percent = Math.round(file.progress * 100);
        if (file.preview && file.status !== "failed") {
          return (
            <li key={file.key} className="relative size-16 shrink-0 rounded-[9px] shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
              <Asset type="image" src={file.preview} alt={file.name} width={1} height={1} fit="cover" unoptimized className="size-full rounded-[9px]" />
              {file.status === "uploading" && (
                <>
                  <span className="sr-only">Uploading {file.name}</span>
                  <span aria-hidden className="absolute inset-0 grid place-items-center rounded-[9px] bg-black/45 text-[11px] font-medium text-white tabular-nums">
                    {percent}%
                  </span>
                </>
              )}
              <RemoveButton name={file.name} onRemove={() => onRemove(file.key)} />
            </li>
          );
        }
        return (
          <li
            key={file.key}
            className={cn("bg-surface-raised relative flex h-16 max-w-full min-w-0 items-center gap-2.5 rounded-[9px] pr-3.5 pl-2.5 md:min-w-[200px]", file.status === "failed" && "shadow-[inset_0_0_0_1px_rgb(249_115_115/0.5)]")}
          >
            <Badge name={file.name} contentType={file.contentType} />
            <span className="flex min-w-0 flex-col">
              <span className="ui-style max-w-[16em] truncate">{file.name}</span>
              {file.status === "failed" ? (
                <span role="alert" className="caption-style text-danger">
                  Couldn&apos;t upload.{" "}
                  <Button variant="link" size="none" onMouseDown={(event) => event.preventDefault()} onClick={() => onRetry(file.key)} className="caption-style text-danger hover:text-danger hit">
                    Try again
                  </Button>
                </span>
              ) : (
                <span className="caption-style text-subtle tabular-nums">{file.status === "uploading" ? `Uploading · ${percent}%` : fileSize(file.size)}</span>
              )}
            </span>
            {file.status === "uploading" && (
              <span aria-hidden className="absolute right-2.5 bottom-[7px] left-2.5 h-[3px] overflow-hidden rounded-full bg-white/8">
                <span className="bg-violet block h-full rounded-full" style={{ width: `${percent}%` }} />
              </span>
            )}
            <RemoveButton name={file.name} onRemove={() => onRemove(file.key)} />
          </li>
        );
      })}
    </ul>
  );
}

function draggingFiles(event: { dataTransfer: DataTransfer | null }) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function useNoFileNavigation() {
  useEffect(() => {
    const hold = (event: globalThis.DragEvent) => {
      if (draggingFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", hold);
    window.addEventListener("drop", hold);
    return () => {
      window.removeEventListener("dragover", hold);
      window.removeEventListener("drop", hold);
    };
  }, []);
}

export function FileDrop({
  label,
  onFiles,
  disabled,
  className,
  role,
  labelledBy,
  children,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  role?: "region";
  labelledBy?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      className={cn("relative", className)}
      role={role}
      aria-labelledby={labelledBy}
      onDragEnter={(event) => {
        if (disabled || !draggingFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled || !draggingFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (disabled || !draggingFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (disabled || !draggingFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2.5 z-30 grid place-items-center rounded-xl bg-[rgb(65_36_251/0.08)] text-center shadow-[inset_0_0_0_2px_#5a4ee6] backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2">
            <UploadIcon aria-hidden className="text-violet size-[18px]" />
            <h3>{label}</h3>
            <p className="caption-style text-subtle">
              Up to {CHAT_FILES_MAX} files, {Math.round(CHAT_FILE_MAX_BYTES / (1024 * 1024))} MB each
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
