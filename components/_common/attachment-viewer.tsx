"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/_ui/sheet";
import { useStandalone } from "@/hooks/use-standalone";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import DownloadIcon from "@/public/assets/images/_common/download.svg";

export type AttachmentFile = {
  name: string;
  contentType: string | null;
  url: string;
  downloadUrl: string;
};

type Kind = "pdf" | "image" | "text";
type Loaded = { blob: Blob; name: string };
type Picture = { src: string; width: number; height: number };
type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "pdf"; pages: Picture[]; done: boolean }
  | { kind: "image"; picture: Picture }
  | { kind: "text"; text: string }
  | { kind: "other" };

const PAGE_WIDTH = 1000;

function kindOf(contentType: string | null, name: string): Kind | null {
  const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (type === "application/pdf") return "pdf";
  if (/^image\/(png|jpe?g|gif|webp)$/.test(type)) return "image";
  if (type === "text/plain") return "text";
  if (type && type !== "application/octet-stream") return null;
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return "image";
  if (/\.txt$/i.test(name)) return "text";
  return null;
}

function filenameFrom(header: string | null) {
  if (!header) return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {}
  }
  return header.match(/filename="([^"]+)"/i)?.[1] ?? null;
}

async function failure(response: Response, fallback: string) {
  const text = (await response.text().catch(() => "")).trim();
  return new Error(text && text.length < 300 ? text : fallback);
}

function touchScreen() {
  return navigator.maxTouchPoints > 0;
}

async function saveFile(file: AttachmentFile, loaded: Loaded | null) {
  let blob = loaded?.blob ?? null;
  let name = loaded?.name ?? file.name;
  if (!blob) {
    const response = await fetch(file.downloadUrl, { cache: "no-store" });
    if (!response.ok) throw await failure(response, "The attachment didn't download. Try again.");
    name = filenameFrom(response.headers.get("content-disposition")) ?? file.name;
    blob = await response.blob();
  }
  const shared = new File([blob], name, {
    type: file.contentType ?? (blob.type || "application/octet-stream"),
  });
  if (navigator.canShare?.({ files: [shared] })) {
    try {
      await navigator.share({ files: [shared] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(shared);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function renderPdf(data: ArrayBuffer, width: number, live: () => boolean, onPage: (page: Blob, width: number, height: number) => void) {
  const { getDocument } = await import("unpdf/pdfjs");
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    for (let number = 1; number <= pdf.numPages && live(); number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: (width * density) / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This device couldn't draw the PDF.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      if (image && live()) onPage(image, viewport.width, viewport.height);
    }
  } finally {
    await task.destroy();
  }
}

function ViewerBody({ file, onLoaded }: { file: AttachmentFile; onLoaded: (loaded: Loaded) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const { url, name, contentType } = file;

  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    const objectUrl = (blob: Blob) => {
      const created = URL.createObjectURL(blob);
      urls.push(created);
      return created;
    };
    const width = Math.max(240, Math.min((scroller.current?.clientWidth ?? PAGE_WIDTH) - 24, PAGE_WIDTH));
    (async () => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw await failure(response, "The attachment didn't open. Try again.");
      const blob = await response.blob();
      if (!live) return;
      const realName = filenameFrom(response.headers.get("content-disposition")) ?? name;
      onLoaded({ blob, name: realName });
      const kind = kindOf(contentType, realName) ?? kindOf(response.headers.get("content-type"), realName);
      if (kind === "image") {
        const size = await createImageBitmap(blob).then(
          (bitmap) => {
            const measured = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            return measured;
          },
          () => ({ width: PAGE_WIDTH, height: PAGE_WIDTH }),
        );
        if (live) setView({ kind: "image", picture: { src: objectUrl(blob), ...size } });
      } else if (kind === "text") {
        const text = await blob.text();
        if (live) setView({ kind: "text", text });
      } else if (kind === "pdf") {
        setView({ kind: "pdf", pages: [], done: false });
        await renderPdf(await blob.arrayBuffer(), width, () => live, (page, pageWidth, pageHeight) => {
          const picture = { src: objectUrl(page), width: Math.round(pageWidth), height: Math.round(pageHeight) };
          setView((current) => (current.kind === "pdf" ? { ...current, pages: [...current.pages, picture] } : current));
        });
        if (live) setView((current) => (current.kind === "pdf" ? { ...current, done: true } : current));
      } else setView({ kind: "other" });
    })().catch((error: unknown) => {
      if (!live) return;
      const message = error instanceof Error && error.message ? error.message : "The attachment didn't open. Try again.";
      setView((current) => (current.kind === "pdf" && current.pages.length > 0 ? { ...current, done: true } : { kind: "error", message }));
    });
    return () => {
      live = false;
      urls.forEach((created) => URL.revokeObjectURL(created));
    };
  }, [url, name, contentType, onLoaded]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
      {view.kind === "loading" && (
        <p role="status" className="caption-style text-subtle p-6 text-center">
          Opening {name}…
        </p>
      )}
      {view.kind === "error" && (
        <p role="alert" className="caption-style text-danger p-6 text-center">
          {view.message}
        </p>
      )}
      {view.kind === "other" && (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-soft">{name} can&apos;t be shown here.</p>
          <p className="caption-style text-subtle">Download it to open it in another app.</p>
        </div>
      )}
      {view.kind === "image" && (
        <div className="flex min-h-full items-center justify-center p-3">
          <Image src={view.picture.src} alt={name} width={view.picture.width} height={view.picture.height} unoptimized className="h-auto max-w-full rounded-md" />
        </div>
      )}
      {view.kind === "text" && <pre className="mx-auto max-w-[60em] p-4 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap">{view.text}</pre>}
      {view.kind === "pdf" && (
        <div className="flex flex-col items-center gap-3 p-3">
          {view.pages.map((page, index) => (
            <Image
              key={page.src}
              src={page.src}
              alt={`Page ${index + 1}`}
              width={page.width}
              height={page.height}
              unoptimized
              className="shadow-overlay h-auto w-full max-w-[1000px] rounded-sm bg-white"
            />
          ))}
          {!view.done && (
            <p role="status" className="caption-style text-subtle py-3">
              {view.pages.length === 0 ? `Opening ${name}…` : "Loading more pages…"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AttachmentDownload({ file, loaded = null, onError, className }: { file: AttachmentFile; loaded?: Loaded | null; onError?: (message: string) => void; className?: string }) {
  const standalone = useStandalone();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      href={file.downloadUrl}
      aria-label={`Download ${file.name}`}
      aria-busy={busy || undefined}
      title="Download"
      className={cn("size-8", busy && "opacity-50", className)}
      onClick={(event) => {
        if (!standalone || !touchScreen()) return;
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        saveFile(file, loaded)
          .catch((error: unknown) => onError?.(error instanceof Error && error.message ? error.message : "The attachment didn't download. Try again."))
          .finally(() => setBusy(false));
      }}
    >
      <DownloadIcon aria-hidden className="size-3.5" />
    </Button>
  );
}

function AttachmentViewer({ file, open, onOpenChange }: { file: AttachmentFile; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLoaded(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="bottom" aria-describedby={undefined} className="inset-0 h-dvh max-h-none rounded-none border-t-0 pt-[env(safe-area-inset-top)] shadow-none">
        <header className="border-line-strong flex h-14 shrink-0 items-center gap-2 border-b pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))]">
          <SheetClose asChild>
            <Button variant="secondary" size="sm" className="gap-1 pr-3">
              <ChevronLeftIcon aria-hidden className="size-3.5" />
              Back
            </Button>
          </SheetClose>
          <SheetTitle className="min-w-0 flex-1 truncate leading-5 font-medium">{file.name}</SheetTitle>
          <AttachmentDownload file={file} loaded={loaded} onError={setError} />
        </header>
        {error && (
          <p role="alert" className="caption-style text-danger border-line-strong border-b px-4 py-2 text-center">
            {error}
          </p>
        )}
        <ViewerBody file={file} onLoaded={setLoaded} />
      </SheetContent>
    </Sheet>
  );
}

export function AttachmentLink({ file, className, children, onError }: { file: AttachmentFile; className?: string; children: ReactNode; onError?: (message: string) => void }) {
  const standalone = useStandalone();
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        className={className}
        onClick={(event) => {
          if (!standalone || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (file.contentType && !kindOf(file.contentType, file.name)) {
            if (!touchScreen()) return;
            event.preventDefault();
            saveFile(file, null).catch((error: unknown) => onError?.(error instanceof Error && error.message ? error.message : "The attachment didn't download. Try again."));
            return;
          }
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {standalone && <AttachmentViewer file={file} open={open} onOpenChange={setOpen} />}
    </>
  );
}
