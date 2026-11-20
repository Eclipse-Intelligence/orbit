"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { NativeSelect } from "@/components/_ui/native-select";
import { Textarea } from "@/components/_ui/textarea";
import { shareMessageAction } from "@/app/(crm)/chat/actions";
import { echoChatEvent } from "@/components/chat/chat-live";
import { useComposer } from "@/components/mail/compose-dock";
import { newClientKey } from "@/lib/chat/client";
import { filesTitle } from "@/lib/chat/files";
import { roomHref } from "@/lib/chat/routes";
import { searchExcerpt } from "@/lib/chat/search";
import { CHAT_BODY_MAX, chatLabel, isDirect, type ChatConversation, type ChatMessage } from "@/lib/chat/types";
import { useChatShare } from "@/stores/chat-share-store";
import { useCompaniesStore } from "@/stores/companies-store";

const SHARE_FAILED = "Couldn't share the message. Try again.";

function optionLabel(conversation: ChatConversation, all: ChatConversation[]) {
  const label = chatLabel(conversation);
  const twin = all.some((other) => other.id !== conversation.id && chatLabel(other) === label);
  return twin && conversation.workspaceName ? `${label} (${conversation.workspaceName})` : label;
}

function ShareForm({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const ids = { target: useId(), comment: useId() };
  const router = useRouter();
  const composer = useComposer();
  const sidebar = useCompaniesStore((store) => store.chat);
  const [targetId, setTargetId] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ target: string; comment: string; key: string } | null>(null);

  const conversations = useMemo(() => sidebar?.conversations ?? [], [sidebar]);
  const rooms = conversations.filter((conversation) => conversation.kind === "room");
  const direct = conversations.filter((conversation) => isDirect(conversation.kind));
  const target = conversations.find((conversation) => conversation.id === targetId) ?? null;
  const excerpt = searchExcerpt(message.body, message.format, "");
  const elsewhere = target !== null && target.id !== message.conversationId;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const text = comment.trim();
    if (!attempt.current || attempt.current.target !== target.id || attempt.current.comment !== text) attempt.current = { target: target.id, comment: text, key: newClientKey() };
    const result = await shareMessageAction({ conversationId: target.id, body: text, clientKey: attempt.current.key, quotedMessageId: message.id }).catch(() => ({ error: SHARE_FAILED }));
    setBusy(false);
    if ("ok" in result && result.ok) {
      echoChatEvent({ type: "message", conversationId: target.id, message: result.message, root: null });
      composer.showToast({ message: `Shared in ${chatLabel(target)}`, action: { label: "View", run: () => router.push(roomHref(target.id)) } });
      onClose();
      return;
    }
    setError("error" in result ? result.error : SHARE_FAILED);
  }

  return (
    <DialogContent className="pointer-coarse:[&>button[aria-label=Close]]:top-2 pointer-coarse:[&>button[aria-label=Close]]:right-2 pointer-coarse:[&>button[aria-label=Close]]:size-11">
      <form onSubmit={submit} data-shortcut-scope>
        <DialogHeader className="pr-12">
          <DialogTitle>Share message</DialogTitle>
          <DialogDescription className="sr-only">Share this message in a room or direct message.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-5">
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.target} className="lead-style font-medium">
              Share in
            </label>
            <NativeSelect id={ids.target} value={targetId} disabled={!sidebar} onChange={(event) => setTargetId(event.target.value)} autoFocus className="max-md:h-11">
              <option value="">{sidebar ? "Choose a conversation" : "Loading…"}</option>
              {rooms.length > 0 && (
                <optgroup label="Rooms">
                  {rooms.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {optionLabel(conversation, conversations)}
                    </option>
                  ))}
                </optgroup>
              )}
              {direct.length > 0 && (
                <optgroup label="Direct messages">
                  {direct.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {optionLabel(conversation, conversations)}
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.comment} className="lead-style font-medium">
              Message
            </label>
            <Textarea id={ids.comment} value={comment} rows={3} maxLength={CHAT_BODY_MAX} placeholder="Add a message (optional)" onChange={(event) => setComment(event.target.value)} className="max-md:min-h-[88px]" />
          </div>
          <div className="border-line-strong flex flex-col gap-1 rounded-[10px] border px-3 py-2.5">
            <span className="text-[12.5px] font-medium">{message.author.name}</span>
            {excerpt && <span className="text-soft line-clamp-3 text-[13.5px] leading-[19px] [overflow-wrap:anywhere]">{excerpt}</span>}
            {message.attachments.length > 0 && <span className="caption-style text-subtle">{excerpt ? `And ${filesTitle(message.attachments.length)}` : `Sent ${filesTitle(message.attachments.length)}`}</span>}
          </div>
          {elsewhere && <p className="caption-style text-subtle">People in {chatLabel(target)} who can&apos;t see the original see &quot;Message unavailable&quot;.</p>}
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="md" className="hit max-md:h-11">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary" size="md" disabled={!target || busy} data-shortcut-submit className="hit max-md:h-11">
            {busy ? "Sharing…" : "Share"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export default function ShareMessageHost() {
  const message = useChatShare((store) => store.message);
  const close = useChatShare((store) => store.close);
  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && close()}>
      {message && <ShareForm key={message.id} message={message} onClose={close} />}
    </Dialog>
  );
}
