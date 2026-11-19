"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { discardChatUploadsAction, prepareChatUploadAction } from "@/app/(crm)/chat/actions";
import { releaseHandedOff } from "@/lib/chat/client";
import { fileSize } from "@/lib/chat/files";
import { imageSize, uploadWithProgress } from "@/lib/chat/uploads";
import { CHAT_FILE_MAX_BYTES, CHAT_FILES_MAX, type ChatAttachment } from "@/lib/chat/types";
import { MEDIA_TYPES } from "@/lib/media-types";

export const UPLOAD_FAILED = "Couldn't upload. Try again.";

export type UploadTarget = () => Promise<{ id: string | null; error: string | null }>;

export type QueuedFile = {
  key: string;
  name: string;
  size: number;
  contentType: string;
  preview: string | null;
  status: "uploading" | "done" | "failed";
  progress: number;
  id: string | null;
  width: number | null;
  height: number | null;
};

let sequence = 0;

function nextKey() {
  sequence += 1;
  return `upload-${Date.now().toString(36)}-${sequence}`;
}

function typeOf(file: File) {
  return file.type || "application/octet-stream";
}

export function queuedAttachment(file: QueuedFile): ChatAttachment {
  return { id: file.id!, name: file.name, contentType: file.contentType, size: file.size, width: file.width, height: file.height };
}

export function attachmentQueued(file: ChatAttachment): QueuedFile {
  return { key: file.id, name: file.name, size: file.size, contentType: file.contentType, preview: null, status: "done", progress: 1, id: file.id, width: file.width, height: file.height };
}

export function useUploads(target: UploadTarget | undefined) {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const sources = useRef(new Map<string, File>());
  const aborts = useRef(new Map<string, AbortController>());
  const latest = useRef(files);
  const targetRef = useRef(target);
  useEffect(() => {
    latest.current = files;
    targetRef.current = target;
  });

  useEffect(() => {
    const running = aborts.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  const patch = useCallback((key: string, change: Partial<QueuedFile>) => {
    setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file)));
  }, []);

  const start = useCallback(
    async (key: string) => {
      const source = sources.current.get(key);
      const goal = targetRef.current;
      if (!source || !goal) return;
      const controller = new AbortController();
      const earlier = latest.current.find((file) => file.key === key)?.id;
      if (earlier) void discardChatUploadsAction([earlier]).catch(() => undefined);
      aborts.current.get(key)?.abort();
      aborts.current.set(key, controller);
      patch(key, { status: "uploading", progress: 0, id: null });
      try {
        const where = await goal();
        if (!where.id) throw new Error(where.error ?? UPLOAD_FAILED);
        const size = await imageSize(source);
        const prepared = await prepareChatUploadAction(where.id, [{ name: source.name || "File", size: source.size, contentType: typeOf(source), width: size?.width ?? null, height: size?.height ?? null }]);
        if (!("ok" in prepared) || !prepared.ok) throw new Error("error" in prepared ? prepared.error : UPLOAD_FAILED);
        const upload = prepared.uploads[0];
        if (controller.signal.aborted) {
          void discardChatUploadsAction([upload.id]).catch(() => undefined);
          return;
        }
        patch(key, { id: upload.id, contentType: upload.contentType, width: size?.width ?? null, height: size?.height ?? null });
        await uploadWithProgress(upload.uploadUrl, new Blob([source], { type: upload.contentType }), upload.name, (progress) => patch(key, { progress }), controller.signal);
        patch(key, { status: "done", progress: 1 });
      } catch (error) {
        if (controller.signal.aborted) return;
        patch(key, { status: "failed" });
        const message = error instanceof Error && error.message && error.message !== "The upload didn't finish." ? error.message : null;
        if (message && message !== UPLOAD_FAILED) setNotice(message);
      } finally {
        if (aborts.current.get(key) === controller) aborts.current.delete(key);
      }
    },
    [patch],
  );

  const add = useCallback(
    (picked: File[]) => {
      if (!targetRef.current || picked.length === 0) return;
      const room = CHAT_FILES_MAX - latest.current.length;
      const empty = picked.find((file) => file.size === 0);
      const fitting = picked.filter((file) => file.size > 0 && file.size <= CHAT_FILE_MAX_BYTES);
      const accepted = fitting.slice(0, Math.max(0, room));
      if (empty) setNotice(`${empty.name || "That file"} is empty.`);
      else if (fitting.length < picked.length) setNotice(`Files can be up to ${fileSize(CHAT_FILE_MAX_BYTES)} each.`);
      else if (accepted.length < fitting.length) setNotice(`Attach up to ${CHAT_FILES_MAX} files to a message.`);
      else setNotice(null);
      if (accepted.length === 0) return;
      const entries = accepted.map((file) => {
        const key = nextKey();
        sources.current.set(key, file);
        const type = typeOf(file);
        return {
          key,
          name: file.name || "File",
          size: file.size,
          contentType: type,
          preview: MEDIA_TYPES.includes(type) ? URL.createObjectURL(file) : null,
          status: "uploading" as const,
          progress: 0,
          id: null,
          width: null,
          height: null,
        };
      });
      setFiles((current) => [...current, ...entries]);
      for (const entry of entries) void start(entry.key);
    },
    [start],
  );

  const forget = useCallback((file: QueuedFile, options: { discard: boolean }) => {
    aborts.current.get(file.key)?.abort();
    aborts.current.delete(file.key);
    sources.current.delete(file.key);
    if (file.preview) URL.revokeObjectURL(file.preview);
    if (options.discard && file.id) void discardChatUploadsAction([file.id]).catch(() => undefined);
  }, []);

  const remove = useCallback(
    (key: string) => {
      const file = latest.current.find((item) => item.key === key);
      if (!file) return;
      forget(file, { discard: true });
      setFiles((current) => current.filter((item) => item.key !== key));
      setNotice(null);
    },
    [forget],
  );

  const take = useCallback(() => {
    const taken = latest.current.filter((file) => file.status === "done" && file.id);
    for (const file of latest.current) forget(file, { discard: false });
    setFiles([]);
    setNotice(null);
    return taken;
  }, [forget]);

  const restore = useCallback((entries: QueuedFile[]) => {
    setFiles((current) => (current.length > 0 ? current : entries.map((entry) => ({ ...entry, preview: null }))));
  }, []);

  const abandon = useCallback(() => {
    for (const file of latest.current) forget(file, { discard: !(file.id && releaseHandedOff(file.id)) });
  }, [forget]);

  const reset = useCallback(() => {
    for (const file of latest.current) forget(file, { discard: true });
    setFiles([]);
    setNotice(null);
  }, [forget]);

  return {
    files,
    notice,
    add,
    remove,
    retry: (key: string) => void start(key),
    take,
    restore,
    reset,
    abandon,
    uploading: files.some((file) => file.status === "uploading"),
    failed: files.some((file) => file.status === "failed"),
    ready: files.filter((file) => file.status === "done"),
  };
}
