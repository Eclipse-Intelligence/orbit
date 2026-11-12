"use client";

import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import DraftShare, { useComposeViewer } from "@/components/mail/draft-share";
import { useMailShareEvents, useShareResync } from "@/components/mail/share-live";
import { DraftRequestError, fetchDraftPeople, fetchSharedDraft, holdSharedDraft, saveSharedDraftText } from "@/components/mail/shared-draft-client";
import { HandOverError } from "@/components/mail/hand-over";
import { SHARED_DRAFT_CHANGED } from "@/lib/mail/share-view";
import { newerVersion, openingBase, reconcileText, sameText, textChanges, type DraftText } from "@/lib/mail/shared-text";
import { LiveDraft, settleForSend } from "@/lib/mail/live-draft-client";
import type { MailSharePerson } from "@/lib/mail/share-types";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import BodyEditor, { type BodyEditorHandle } from "@/components/mail/body-editor";
import { useComposer } from "@/components/mail/compose-dock";
import { FollowUpBlock, NoReplyMenu, type NoReplyChoice, type NoReplyThen } from "@/components/mail/follow-up-composer";
import { holdDraft, releaseDraft } from "@/components/mail/held-drafts";
import { ComposerReconnect, flagReconnect, reconnectOf } from "@/components/mail/reconnect-notice";
import { fromFallback } from "@/lib/mail/mailboxes";
import { draftQueued, holdQueuedDraft, newSendKey, unscheduleDraft, writeWithAi, type MailRequestError } from "@/components/mail/mail-cache";
import RecipientField from "@/components/mail/recipient-field";
import { laterDetail, laterOptions } from "@/lib/mail/later";
import { MODE_LABEL } from "@/lib/mail/format";
import { useShortcutHint, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, DraftFile, DraftMode, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import BoldIcon from "@/public/assets/images/mail/bold.svg";
import ItalicIcon from "@/public/assets/images/mail/italic.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1500;
const LIVE_OFFLINE = "Couldn't reach Orbit. Try again.";
const FILE_LINK_ERROR = "That's a link to a local file. Drag or paste the file itself.";

export type SendPayload = {
  id: string | null;
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  signature: boolean;
  remindHours: number | null;
  followUpDays: number | null;
  followUpBody: string | null;
  attachments: string[];
  files: DraftFile[];
  replaces?: string | null;
  identityId?: string | null;
  sendKey?: string | null;
  force?: boolean;
  shareId?: string | null;
  shareBase?: SharedBase | null;
};

export type SharedBase = { text: DraftText; version: number };

export type ComposerDraft = MailDraft & { shareBase?: SharedBase | null; sendKey?: string | null; sendProblem?: string | null; replaces?: string | null; unsaved?: boolean };

export type SendTracker = () => { undone: () => void; delivered: () => void };

export type ComposerStart = {
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  draft: ComposerDraft | null;
  replaces?: string | null;
  fromId?: string | null;
  fromEmail?: string | null;
  heldKey?: string;
};

type SaveState = { kind: "idle" | "saving" | "saved" | "held" | "error"; message?: string };

async function postJson<T>(url: string, body: unknown, keepalive = false): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string; reconnect?: unknown };
  if (!response.ok) throw Object.assign(new Error(json.error ?? "Couldn't save the draft. Try again."), { status: response.status, reconnect: json.reconnect ?? null, detail: json });
  return json;
}

export default function MailComposer({
  start,
  accounts,
  variant,
  onSent,
  onClose,
  onSubject,
  onDelivered,
  onUndone,
  onReopen,
  onAlreadySending,
  track,
  onScheduled,
  onDiscard,
  onHeld,
  passive = false,
  threadPeople = [],
}: {
  passive?: boolean;
  threadPeople?: MailSharePerson[];
  onHeld?: (held: boolean) => void;
  start: ComposerStart;
  accounts: ComposeAccount[];
  variant: "inline" | "card";
  onSent: (body: string, to: MailAddress[]) => void;
  onClose: () => void;
  onSubject?: (subject: string) => void;
  onDelivered?: () => void;
  onUndone?: () => void;
  onReopen?: (draft: ComposerDraft) => boolean;
  onAlreadySending?: () => void;
  track?: SendTracker;
  onScheduled?: () => void;
  onDiscard?: () => void;
}) {
  const { queueSend, scheduleSend, pickLater, showToast } = useComposer();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUndo, setAiUndo] = useState<string | null>(null);
  const aiInput = useRef<HTMLInputElement>(null);
  const aiHint = useShortcutHint("mail-ai-write");
  const id = useId();
  const sendHint = useShortcutHint("submit");
  const { mac } = useShortcuts();
  const draft = start.draft;
  const [fromId, setFromId] = useState(
    draft?.identityId ? `smtp:${draft.identityId}` : (start.fromId ?? draft?.sourceId ?? start.sourceId),
  );
  const chosenAccount = accounts.find((item) => item.id === fromId) ?? null;
  const [knownFrom, setKnownFrom] = useState(chosenAccount?.email ?? start.fromEmail ?? null);
  if (chosenAccount && chosenAccount.email !== knownFrom) setKnownFrom(chosenAccount.email);
  const fallbackAccount = chosenAccount || accounts.length === 0 ? null : fromFallback(accounts, draft?.sourceId ?? start.sourceId);
  const fromAccount = chosenAccount ?? fallbackAccount;
  const lostFrom = fallbackAccount ? knownFrom : null;
  const sourceId = fromAccount?.sourceId ?? fromAccount?.id ?? draft?.sourceId ?? start.sourceId;
  const identityId = fromAccount?.identityId ?? null;
  const fromChoices = start.mode === "new" ? accounts : accounts.filter((item) => (item.sourceId ?? item.id) === (draft?.sourceId ?? start.sourceId));
  const [to, setTo] = useState<MailAddress[]>(draft?.to ?? start.to);
  const [cc, setCc] = useState<MailAddress[]>(draft?.cc ?? start.cc);
  const [bcc, setBcc] = useState<MailAddress[]>(draft?.bcc ?? []);
  const [showCopies, setShowCopies] = useState(Boolean(draft?.cc.length || draft?.bcc.length || start.cc.length));
  const [subject, setSubject] = useState(draft?.subject || start.subject);
  const [body, setBody] = useState(draft?.body ?? "");
  const [noReply, setNoReply] = useState<NoReplyChoice>({ remindHours: draft?.remindHours ?? null, followUpDays: draft?.followUpDays ?? null });
  const [noReplyThen, setNoReplyThen] = useState<NoReplyThen>(draft?.followUpDays ? "send" : "remind");
  const [followUpBody, setFollowUpBody] = useState(draft?.followUpBody ?? "");
  const [withSignature, setWithSignature] = useState(true);
  const [save, setSave] = useState<SaveState>(draft?.savedAt ? { kind: "saved" } : { kind: "idle" });
  const lastSaveError = useRef<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState(draft?.sendAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const attachments = useEmailAttachments(draft?.attachments);
  const fileKey = attachments.ids.join(",");
  const savedFiles = useRef(fileKey);
  const draftId = useRef<string | null>(draft?.id || null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = useRef(Boolean(start.heldKey || draft?.unsaved));
  const discarded = useRef(false);
  const heldKey = useRef<string | null>(start.heldKey ?? null);
  const heldNow = useRef(false);
  const heldExtras = useRef({ email: fromAccount?.email ?? null, files: attachments.files });
  const sendKey = useRef<string | null>(draft?.sendKey ?? null);
  const queued = useRef(false);
  const [sendProblem, setSendProblem] = useState(draft?.sendProblem ?? null);
  const editor = useRef<BodyEditorHandle>(null);
  const viewer = useComposeViewer();
  const savedBody = useRef<string | null>(draft?.body ?? null);
  const makeLive = (id: string, base: string) =>
    new LiveDraft({
      shareId: id,
      user: { id: viewer?.id ?? "owner", name: viewer?.name ?? "", kind: "person" },
      base,
      onLocked: () => void loadShared().catch(() => undefined),
      onFailure: (message) => setSave({ kind: "error", message }),
      onStatus: (status) => {
        if (status === "offline") setSave({ kind: "error", message: LIVE_OFFLINE });
        else if (status === "live" || status === "solo") setSave((current) => (current.kind === "error" && current.message === LIVE_OFFLINE ? { kind: "saved" } : current));
      },
    });
  const [live, setLive] = useState<LiveDraft | null>(() => (draft?.shareId ? makeLive(draft.shareId, draft.shareBase?.text.body ?? draft.body ?? "") : null));
  const liveRef = useRef(live);
  const [formats, setFormats] = useState({ bold: false, italic: false });
  const payload = useRef({
    mode: start.mode,
    messageId: start.messageId,
    sourceId,
    identityId,
    to,
    cc,
    bcc,
    subject,
    body,
    signature: withSignature,
    replaces: start.replaces ?? null,
    attachments: attachments.ids,
    remindHours: noReply.remindHours,
    followUpDays: noReply.followUpDays,
    followUpBody: noReply.followUpDays ? followUpBody : null,
  });
  const account = fromAccount;
  const showSubject = start.mode === "new" || start.mode === "forward";
  const card = variant === "card";

  useEffect(() => {
    payload.current = {
      mode: start.mode,
      messageId: start.messageId,
      sourceId,
      identityId,
      to,
      cc,
      bcc,
      subject,
      body,
      signature: withSignature,
      replaces: start.replaces ?? null,
      attachments: attachments.ids,
      remindHours: noReply.remindHours,
      followUpDays: noReply.followUpDays,
      followUpBody: noReply.followUpDays ? followUpBody : null,
    };
    heldExtras.current = { email: fromAccount?.email ?? null, files: attachments.files };
    heldNow.current = save.kind === "held";
  });

  const heldListener = useRef(onHeld);
  useEffect(() => {
    heldListener.current = onHeld;
  });

  useEffect(() => {
    heldListener.current?.(save.kind === "held");
  }, [save.kind]);

  useEffect(() => {
    const retry = () => {
      if (document.visibilityState === "visible" && heldNow.current) void saveRef.current();
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, []);

  useEffect(() => {
    if (savedFiles.current === fileKey) return;
    savedFiles.current = fileKey;
    dirty.current = true;
  }, [fileKey]);

  const subjectListener = useRef(onSubject);
  useEffect(() => {
    subjectListener.current = onSubject;
  });

  useEffect(() => {
    subjectListener.current?.(subject);
  }, [subject]);

  const opening = useRef({ card, passive, recipientsFirst: !draft && (start.mode === "forward" || (start.mode === "new" && start.to.length === 0)) });
  useEffect(() => {
    if (opening.current.passive && window.matchMedia("(max-width: 639px)").matches) return;
    if (!opening.current.card) editor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!opening.current.recipientsFirst) editor.current?.focus();
  }, []);

  function saveNow() {
    const run = chain.current.then(async () => {
      if (!dirty.current || discarded.current) return;
      const snapshot = { ...payload.current, id: draftId.current, sendKey: sendKey.current };
      if (!draftId.current && !snapshot.body.trim() && !snapshot.subject.trim()) return;
      dirty.current = false;
      setSave({ kind: "saving" });
      try {
        await mergeSharedText();
        await liveRef.current?.flush();
        const saved = await postJson<MailDraft>("/api/mail/drafts", snapshot);
        draftId.current = saved.id;
        savedBody.current = saved.body;
        releaseDraft(heldKey.current);
        heldKey.current = null;
        lastSaveError.current = null;
        setSave({ kind: "saved" });
      } catch (problem) {
        dirty.current = true;
        const recreated = (problem as { detail?: { draftId?: unknown } }).detail?.draftId;
        if (typeof recreated === "string") draftId.current = recreated;
        lastSaveError.current = problem instanceof Error ? problem.message : "Couldn't save the draft. Try again.";
        if (flagReconnect(problem, { sourceId: snapshot.sourceId, email: account?.email ?? null })) {
          keepHeld();
          setSave({ kind: "held" });
        } else setSave({ kind: "error", message: problem instanceof Error ? problem.message : "Couldn't save the draft." });
      }
    });
    chain.current = run;
    return run;
  }

  function keepHeld() {
    if (discarded.current || shared.current.id) return;
    heldKey.current ??= crypto.randomUUID();
    const current = payload.current;
    holdDraft({
      key: heldKey.current,
      fromEmail: heldExtras.current.email,
      at: Date.now(),
      draft: {
        id: draftId.current ?? "",
        sourceId: current.sourceId,
        mode: current.mode,
        messageId: current.messageId,
        to: current.to,
        cc: current.cc,
        bcc: current.bcc,
        subject: current.subject,
        body: current.body,
        savedAt: "",
        sendAt: null,
        sendError: null,
        identityId: current.identityId,
        replaces: current.replaces,
        attachments: heldExtras.current.files,
        remindHours: current.remindHours,
        followUpDays: current.followUpDays,
        followUpBody: current.followUpBody,
      },
    });
  }

  const saveRef = useRef(saveNow);
  const keepRef = useRef(keepHeld);
  useEffect(() => {
    saveRef.current = saveNow;
    keepRef.current = keepHeld;
  });

  const [shareId, setShareId] = useState<string | null>(draft?.shareId ?? null);
  const [sharePeople, setSharePeople] = useState<MailSharePerson[]>([]);
  const shared = useRef<{ id: string | null; opened: DraftText; base: SharedBase | null; seen: number | null; asked: number; applied: number }>({
    id: draft?.shareId ?? null,
    opened: draft?.shareBase && draft.shareBase.version < 0 ? draft.shareBase.text : { subject: draft?.subject || start.subject, body: draft?.body ?? "" },
    base: draft?.shareBase && draft.shareBase.version >= 0 ? draft.shareBase : null,
    seen: draft?.shareBase && draft.shareBase.version >= 0 ? draft.shareBase.version : null,
    asked: 0,
    applied: 0,
  });

  useEffect(() => {
    shared.current.id = shareId;
  }, [shareId]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const loadShared = useCallback(async () => {
    const id = shared.current.id;
    if (!id) return;
    fetchDraftPeople(id).then(setSharePeople, () => undefined);
    const ask = ++shared.current.asked;
    const fresh = await fetchSharedDraft(id);
    if (shared.current.id !== id || ask < shared.current.applied || !newerVersion(shared.current.seen, fresh.version)) return;
    shared.current.applied = ask;
    shared.current.seen = fresh.version;
    if (fresh.state === "sent" || fresh.state === "discarded" || fresh.state === "none") return;
    const freshText = { subject: fresh.subject, body: fresh.body };
    const local = { subject: payload.current.subject, body: payload.current.body };
    const merged = reconcileText(openingBase(shared.current.base, shared.current.opened), local, freshText);
    const next = liveRef.current ? { ...merged, body: local.body } : merged;
    shared.current.base = { text: freshText, version: fresh.version };
    if (sameText(next, local)) return;
    payload.current = { ...payload.current, ...next };
    setSubject(next.subject);
    setBody(next.body);
  }, []);

  useEffect(() => {
    if (shareId) void loadShared().catch(() => undefined);
  }, [shareId, loadShared]);

  useMailShareEvents((event) => {
    if (event.shareId === shared.current.id && (event.type === "draft" || event.type === "people")) void loadShared().catch(() => undefined);
  });

  useShareResync(() => {
    const base = shared.current.base;
    const local = { subject: payload.current.subject, body: liveRef.current ? (base?.text.body ?? "") : payload.current.body };
    if (!shared.current.id || (base && !sameText(base.text, local))) return;
    void loadShared().catch(() => undefined);
    liveRef.current?.refresh();
  });

  async function mergeSharedText(retry = true): Promise<void> {
    const id = shared.current.id;
    if (!id) return;
    if (!shared.current.base) await loadShared();
    const base = shared.current.base;
    if (!base) throw new Error("Couldn't save the draft. Try again.");
    const local = { subject: payload.current.subject, body: payload.current.body };
    if (liveRef.current) {
      if (local.subject === base.text.subject) return;
      const saved = await saveSharedDraftText(id, { subject: local.subject, body: null }, null);
      if (saved.version >= (shared.current.seen ?? 0)) {
        shared.current.base = { text: { ...base.text, subject: local.subject }, version: saved.version };
        shared.current.seen = saved.version;
      }
      return;
    }
    const changes = textChanges(base.text, local);
    if (!changes) return;
    try {
      const saved = await saveSharedDraftText(id, changes, base.version);
      if (saved.version >= (shared.current.seen ?? 0)) {
        shared.current.base = { text: local, version: saved.version };
        shared.current.seen = saved.version;
      }
    } catch (problem) {
      if (!(problem instanceof DraftRequestError && problem.detail.changed)) throw problem;
      if (!retry) throw new Error("Couldn't save. Try again.");
      await loadShared();
      await mergeSharedText(false);
    }
  }

  async function refreshedVersion() {
    const before = { subject: payload.current.subject, body: payload.current.body };
    await loadShared();
    const after = { subject: payload.current.subject, body: payload.current.body };
    const base = shared.current.base;
    if (!base || !sameText(before, after) || !sameText(base.text, after)) throw new Error(SHARED_DRAFT_CHANGED);
    return base.version;
  }

  function flushSharedText() {
    const id = shared.current.id;
    const base = shared.current.base;
    if (!id || !base || discarded.current) return;
    if (liveRef.current) {
      if (payload.current.subject !== base.text.subject) void saveSharedDraftText(id, { subject: payload.current.subject, body: null }, null, true).catch(() => undefined);
      return;
    }
    const changes = textChanges(base.text, { subject: payload.current.subject, body: payload.current.body });
    if (changes) void saveSharedDraftText(id, changes, base.version, true).catch(() => undefined);
  }

  const flushRef = useRef(flushSharedText);
  useEffect(() => {
    flushRef.current = flushSharedText;
  });

  useEffect(() => {
    const flush = () => flushRef.current();
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      void chain.current.catch(() => null).then(flush);
    };
  }, []);

  async function ensureSaved(): Promise<{ id: string } | { error: string }> {
    if (!draftId.current && !payload.current.body.trim() && !payload.current.subject.trim()) return { error: "Write something first, then share it." };
    dirty.current = true;
    await saveNow();
    if (draftId.current) return { id: draftId.current };
    return { error: lastSaveError.current ?? "Couldn't save the draft. Try again." };
  }

  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [fromId, to, cc, bcc, subject, body, withSignature, fileKey, noReply, followUpBody]);

  useEffect(
    () => () => {
      if (!dirty.current || discarded.current || shared.current.id) return;
      const snapshot = { ...payload.current };
      if (!draftId.current && !snapshot.body.trim() && !snapshot.subject.trim()) return;
      void chain.current
        .catch(() => null)
        .then(() => postJson("/api/mail/drafts", { ...snapshot, id: draftId.current, sendKey: sendKey.current }, true))
        .then(() => releaseDraft(heldKey.current))
        .catch((problem: unknown) => {
          if (reconnectOf(problem)) keepRef.current();
        });
    },
    [],
  );

  function takeFiles(files: File[]) {
    const taken = attachments.items.map((item) => item.name);
    const images: string[] = [];
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    const named = files.map((file, index) => {
      const base = file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `Pasted image ${stamp}${files.length > 1 ? ` ${index + 1}` : ""}.${file.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
      let name = base;
      for (let copy = 2; taken.includes(name); copy += 1) name = base.replace(/(\.[^.]+)?$/, ` (${copy})$1`);
      taken.push(name);
      if (file.type.startsWith("image/")) images.push(name);
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
    });
    void attachments.add(named);
    if (images.length === 0) return;
    editor.current?.insertBlock(images.map((name) => `[Image: ${name}]`).join("\n"));
  }

  function dropFiles(event: DragEvent) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      event.preventDefault();
      setError(null);
      takeFiles(files);
      return;
    }
    if (/^file:/i.test(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"))) {
      event.preventDefault();
      setError(FILE_LINK_ERROR);
    }
  }

  function editorFiles(files: File[]) {
    setError(null);
    takeFiles(files);
  }

  function fileLinkDropped() {
    setError(FILE_LINK_ERROR);
  }

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      dirty.current = true;
      setter(value);
    };
  }

  function ready() {
    if (attachments.blocked) return false;
    if (to.length + cc.length + bcc.length === 0) {
      setError("Add a recipient.");
      return false;
    }
    if (start.mode === "new" && !subject.trim()) {
      setError("Enter a subject.");
      return false;
    }
    if (!body.trim() && start.mode !== "forward") {
      setError("Add a message.");
      return false;
    }
    return true;
  }

  function handOver(force = false, sending = false): Promise<SendPayload> {
    const liveDraft = shared.current.id ? liveRef.current : null;
    const release = liveDraft?.retain() ?? null;
    const shownLive = liveDraft ? (liveDraft.text() ?? payload.current.body) : null;
    const shownSubject = payload.current.subject;
    const snapshot = { ...payload.current, ...(shownLive !== null ? { body: shownLive } : {}), attachments: attachments.ids, files: attachments.files };
    dirty.current = false;
    releaseDraft(heldKey.current);
    heldKey.current = null;
    const pending = chain.current.catch(() => null);
    const handed = () => ({
      ...snapshot,
      id: draftId.current,
      sendKey: sendKey.current,
      shareId: shared.current.id,
      shareBase: shared.current.base ?? { text: shared.current.opened, version: -1 },
      ...(force ? { force } : {}),
    });
    if (!shared.current.id) return pending.then(handed);
    const failedBase = (): SharedBase | null => {
      const confirmed = liveDraft?.confirmedText();
      return liveDraft && confirmed !== null && confirmed !== undefined
        ? { text: { subject: shared.current.base?.text.subject ?? shownSubject, body: confirmed }, version: shared.current.base?.version ?? -1 }
        : null;
    };
    return pending
      .then(() => mergeSharedText())
      .then(async () => {
        const id = draftId.current;
        if (!id) return;
        if (liveDraft && shownLive !== null) {
          const shareId = shared.current.id!;
          const settled = async () => {
            const fresh = await settleForSend(liveDraft, { subject: shownSubject, body: shownLive }, () => fetchSharedDraft(shareId), SHARED_DRAFT_CHANGED);
            shared.current.base = { text: { subject: fresh.subject, body: fresh.body }, version: fresh.version };
            shared.current.seen = Math.max(shared.current.seen ?? 0, fresh.version);
            return fresh.version;
          };
          const version = await settled();
          if (!sending) return;
          await holdSharedDraft(id, true, version).catch(async (problem: unknown) => {
            if (!(problem instanceof DraftRequestError && problem.detail.changed)) throw problem;
            await holdSharedDraft(id, true, await settled());
          });
          return;
        }
        if (!sending) {
          await refreshedVersion();
          return;
        }
        await holdSharedDraft(id, true, shared.current.base?.version ?? null).catch(async (problem: unknown) => {
          if (!(problem instanceof DraftRequestError && problem.detail.changed)) throw problem;
          await holdSharedDraft(id, true, await refreshedVersion());
        });
      })
      .then(handed, (problem: unknown) => {
        const base = failedBase();
        throw new HandOverError(problem instanceof Error ? problem.message : "Couldn't send. Try again.", {
          ...handed(),
          ...(base ? { shareBase: base } : {}),
          body: liveDraft?.text() ?? payload.current.body,
          subject: payload.current.subject,
        });
      })
      .finally(() => release?.());
  }

  function send(event?: FormEvent, force = false) {
    event?.preventDefault();
    if (queued.current || !ready()) return;
    if (draftQueued(draftId.current, start.replaces)) {
      dirty.current = false;
      showToast({ message: "This email is already sending. Undo it to make changes." });
      (onAlreadySending ?? onClose)();
      return;
    }
    queued.current = true;
    sendKey.current ??= newSendKey();
    const handed = handOver(force, true);
    const release = holdQueuedDraft(draftId.current, handed, start.replaces ?? null);
    const tracked = track?.();
    const sharedDraft = Boolean(shared.current.id);
    queueSend(handed, {
      onDelivered: () => {
        onDelivered?.();
        tracked?.delivered();
      },
      onReopen,
      track,
      onUndone: () => {
        if (sharedDraft) {
          void handed.then(
            (value) => (value.id ? holdSharedDraft(value.id, false).then(() => loadShared(), () => null).catch(() => null) : null),
            () => null,
          );
        }
        void release();
        onUndone?.();
        tracked?.undone();
      },
    });
    onSent(body, [...to, ...cc]);
  }

  function sendLater() {
    if (!ready()) return;
    const now = Date.now();
    pickLater({
      title: "Send later",
      options: laterOptions(now),
      now,
      onPick: (at, detail) => {
        scheduleSend(handOver(), at, detail);
        onScheduled?.();
        onClose();
      },
    });
  }

  async function unschedule() {
    const current = draftId.current;
    if (!current) return;
    const previous = scheduledFor;
    setScheduledFor(null);
    setError(null);
    try {
      await unscheduleDraft(current);
      if (shared.current.id) void loadShared().catch(() => undefined);
    } catch (problem) {
      const status = (problem as MailRequestError).status;
      if (status !== 404 && status !== 409) setScheduledFor(previous);
      setError(problem instanceof Error ? problem.message : "Couldn't unschedule. Try again.");
    }
  }

  async function discard() {
    discarded.current = true;
    dirty.current = false;
    releaseDraft(heldKey.current);
    heldKey.current = null;
    await chain.current.catch(() => null);
    const current = draftId.current;
    draftId.current = null;
    onDiscard?.();
    onClose();
    if (current) await fetch(`/api/mail/drafts?id=${encodeURIComponent(current)}`, { method: "DELETE" }).catch(() => null);
  }

  async function writeAi() {
    if (aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await writeWithAi({ mode: start.mode, messageId: start.messageId, to: [...to, ...cc], subject, instruction: aiText, current: body });
      setAiUndo(body);
      if (liveRef.current) editor.current?.setText(result.body);
      else change(setBody)(result.body);
      setAiOpen(false);
      setAiText("");
      window.setTimeout(() => editor.current?.focus(), 0);
    } catch (problem) {
      setAiError(problem instanceof Error ? problem.message : "The AI didn't answer. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  function openAi() {
    setAiOpen(true);
    setAiError(null);
    window.setTimeout(() => aiInput.current?.focus(), 0);
  }

  const status = save.kind === "error" ? save.message : "";

  return (
    <form
      onSubmit={send}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
          event.preventDefault();
          openAi();
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("text/uri-list")) event.preventDefault();
      }}
      onDrop={dropFiles}
      aria-label={MODE_LABEL[start.mode]}
      className={cn(
        "flex min-h-0 flex-col gap-1",
        card ? "flex-1" : "animate-rise-in bg-surface-field rounded-2xl px-4 pt-3 pb-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]",
      )}
    >
      <div data-composer-scroll="" className={card ? "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-4 pt-1" : "contents"}>
      {!card && (
        <div className={fromChoices.length > 1 && !status ? "sr-only" : "flex items-center justify-between gap-3 pb-1"}>
          {fromChoices.length <= 1 && (
            <span className="caption-style text-subtle">
              {MODE_LABEL[start.mode]} from {account?.email ?? "your mailbox"}
            </span>
          )}
          <span role="status" className={cn("caption-style ml-auto", save.kind === "error" ? "text-danger" : "text-subtle")}>
            {status}
          </span>
        </div>
      )}
      {fallbackAccount && (
        <p role="status" className="caption-style text-subtle">
          {`${lostFrom ?? "That address"} is no longer available. Sending from ${fallbackAccount.email}.`}
        </p>
      )}
      {fromChoices.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-from`} className="text-subtle w-8 shrink-0 text-[13px]">
            From
          </label>
          <span className="relative flex min-w-0 items-center">
            <select
              id={`${id}-from`}
              value={fromAccount?.id ?? fromId}
              onChange={(event) => change(setFromId)(event.target.value)}
              className="text-foreground h-7 min-w-0 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-0 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {fromChoices.map((item) => (
                <option key={item.id} value={item.id} className="bg-popover">
                  {item.email}
                </option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden className="text-subtle pointer-events-none absolute right-1 size-3" />
          </span>
        </div>
      )}
      <RecipientField
        label="To"
        value={to}
        onChange={change(setTo)}
        autoFocus={!draft && (start.mode === "forward" || (start.mode === "new" && start.to.length === 0))}
        trailing={
          !showCopies && (
            <Button variant="ghost" size="sm" onClick={() => setShowCopies(true)} aria-label="Add Cc and Bcc" className="font-normal">
              Cc Bcc
            </Button>
          )
        }
      />
      {showCopies && (
        <>
          <RecipientField label="Cc" value={cc} onChange={change(setCc)} />
          <RecipientField label="Bcc" value={bcc} onChange={change(setBcc)} />
        </>
      )}
      {showSubject && (
        <div className={cn("flex items-center gap-2", card && "mt-1")}>
          <label htmlFor={`${id}-subject`} className={cn("text-subtle min-w-8 shrink-0 text-[13px]", card && "sr-only")}>
            Subject
          </label>
          <input
            id={`${id}-subject`}
            value={subject}
            onChange={(event) => change(setSubject)(event.target.value)}
            placeholder="Subject"
            className={cn(
              "text-foreground placeholder:text-subtle h-8 min-w-0 flex-1 bg-transparent outline-none",
              card ? "text-[16px] font-medium" : "text-[14px]",
            )}
          />
        </div>
      )}
      {aiOpen && (
        <div className="animate-rise-in mt-2 flex flex-col gap-1.5 rounded-xl bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] px-3 py-2">
          <div className="flex items-center gap-2">
            <SparkleIcon aria-hidden className={cn("text-primary-foreground size-3.5 shrink-0", aiBusy && "animate-pulse")} />
            <label htmlFor={`${id}-ai`} className="sr-only">
              What should the email say?
            </label>
            <input
              ref={aiInput}
              id={`${id}-ai`}
              value={aiText}
              disabled={aiBusy}
              onChange={(event) => setAiText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void writeAi();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAiOpen(false);
                  editor.current?.focus();
                }
              }}
              placeholder={body.trim() ? "How should it change? (optional)" : "What should it say? (optional)"}
              className="text-foreground placeholder:text-subtle h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none disabled:opacity-60"
            />
            <Button variant="ghost" size="sm" onClick={() => void writeAi()} disabled={aiBusy}>
              {aiBusy ? "Writing…" : "Write"}
            </Button>
          </div>
          {aiError && (
            <p role="alert" className="caption-style text-danger">
              {aiError}
            </p>
          )}
        </div>
      )}
      {aiUndo !== null && !aiOpen && (
        <p className="caption-style text-subtle flex items-center gap-2 pt-2">
          <SparkleIcon aria-hidden className="size-3" />
          Written with AI. Check before sending.
          <Button
            variant="link"
            size="none"
            onClick={() => {
              if (liveRef.current) editor.current?.setText(aiUndo);
              else change(setBody)(aiUndo);
              setAiUndo(null);
            }}
            className="font-normal"
          >
            Undo
          </Button>
        </p>
      )}
      <BodyEditor
        ref={editor}
        value={body}
        onChange={change(setBody)}
        onFiles={editorFiles}
        onFileLink={fileLinkDropped}
        onFormats={(next) => setFormats((current) => (current.bold === next.bold && current.italic === next.italic ? current : next))}
        label="Message"
        placeholder={start.mode === "forward" ? "Add a note" : start.mode === "new" ? "Write your email" : "Write your reply"}
        fill={card}
        live={live}
      />
      {account?.signature && (
        <div className="flex items-start gap-3 pb-1">
          <p className={cn("caption-style min-w-0 flex-1 whitespace-pre-wrap", withSignature ? "text-subtle" : "text-faint line-through")}>
            {account.signature}
          </p>
          <Button variant="ghost" size="sm" onClick={() => change(setWithSignature)(!withSignature)} className="-my-1 font-normal">
            {withSignature ? "Remove signature" : "Add signature"}
          </Button>
        </div>
      )}
      <AttachmentList items={attachments.items} onRemove={attachments.remove} />
      {noReply.followUpDays && (
        <FollowUpBlock
          days={noReply.followUpDays}
          body={followUpBody}
          onBody={change(setFollowUpBody)}
          onRemove={() => {
            dirty.current = true;
            setNoReply({ remindHours: null, followUpDays: null });
            setFollowUpBody("");
          }}
        />
      )}
      {scheduledFor && (
        <p className="caption-style text-soft flex items-center gap-2">
          <ClockIcon aria-hidden className="text-primary size-3.5" />
          Scheduled for {laterDetail(scheduledFor, Date.parse(draft?.savedAt || scheduledFor))}. Changes here go out with it.
          <Button variant="link" size="none" onClick={() => void unschedule()} className="font-normal">
            Unschedule
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {attachments.blocked && (
        <p id={`${id}-send-blocked`} role="status" className="caption-style text-subtle">
          {attachments.blocked}
        </p>
      )}
      {sendProblem && (
        <div role="alert" className="caption-style text-danger flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{sendProblem}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={Boolean(attachments.blocked)}
            onClick={() => {
              setSendProblem(null);
              send(undefined, true);
            }}
          >
            Send anyway
          </Button>
        </div>
      )}
      {!sendProblem && <ComposerReconnect sourceId={sourceId} email={account?.email ?? null} held={save.kind === "held"} />}
      </div>
      <div role="group" aria-label="Email actions" className={cn("flex items-center gap-1 pt-2", card && "shrink-0 px-4 pb-3")}>
        <Button
          variant="primary"
          type="submit"
          data-shortcut-submit
          title={`Send (${sendHint})`}
          disabled={Boolean(attachments.blocked)}
          aria-describedby={attachments.blocked ? `${id}-send-blocked` : undefined}
        >
          {scheduledFor ? "Send now" : "Send"}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Send later" title="Send later" onClick={sendLater}>
          <ClockIcon aria-hidden className="size-3.5" />
        </Button>
        <NoReplyMenu
          choice={noReply}
          then={noReplyThen}
          onChange={(choice, then) => {
            dirty.current = true;
            setNoReply(choice);
            setNoReplyThen(then);
          }}
        />
        <AttachButton id={`${id}-attach`} onFiles={(files) => void attachments.add(files)} compact />
        <DraftShare
          mode={start.mode}
          shareId={shareId}
          people={sharePeople}
          threadPeople={threadPeople}
          ensureSaved={ensureSaved}
          onPeople={setSharePeople}
          onShared={(id, people) => {
            shared.current = { id, opened: { subject: payload.current.subject, body: payload.current.body }, base: null, seen: null, asked: 0, applied: 0 };
            liveRef.current?.close();
            const created = makeLive(id, savedBody.current ?? payload.current.body);
            liveRef.current = created;
            setLive(created);
            setShareId(id);
            setSharePeople(people);
            releaseDraft(heldKey.current);
            heldKey.current = null;
          }}
        />
        <Button variant="ghost" size="icon" aria-label="Write with AI" title={`Write with AI (${aiHint})`} onClick={openAi}>
          <SparkleIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Bold"
          aria-pressed={formats.bold}
          className={cn(formats.bold && "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white")}
          title={`Bold (${mac ? "⌘B" : "Ctrl+B"})`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => editor.current?.toggle("**")}
        >
          <BoldIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Italic"
          aria-pressed={formats.italic}
          className={cn(formats.italic && "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white")}
          title={`Italic (${mac ? "⌘I" : "Ctrl+I"})`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => editor.current?.toggle("*")}
        >
          <ItalicIcon aria-hidden className="size-3.5" />
        </Button>
        {card && (
          <span role="status" className={cn("caption-style ml-2 min-w-0 truncate", save.kind === "error" ? "text-danger" : "text-subtle")}>
            {status}
          </span>
        )}
        <HoldButton
          onConfirm={() => void discard()}
          holding={
            <span className="flex items-center gap-1.5">
              <TrashIcon aria-hidden className="size-3.5" />
              <span className="max-sm:sr-only">Keep holding</span>
            </span>
          }
          className="ml-auto sm:w-[8.25rem]"
        >
          <span className="flex items-center gap-1.5">
            <TrashIcon aria-hidden className="size-3.5" />
            <span className="max-sm:sr-only">Hold to discard</span>
          </span>
        </HoldButton>
      </div>
    </form>
  );
}
