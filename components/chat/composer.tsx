"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import MentionInput from "@/components/assistant/mention-input";
import { useChat } from "@/components/chat/chat-context";
import { messageBody } from "@/components/chat/use-chat-actions";
import { draftKey, readDraft, writeDraft } from "@/lib/chat/client";
import { CHAT_BODY_MAX } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";

const GROW_MAX_PX = 200;

function subscribeNothing() {
  return () => {};
}

export function focusComposer(from: Element | null) {
  const scope = from?.closest("[data-chat-room-pane], [data-chat-thread-pane]") ?? document;
  scope.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.focus({ preventScroll: true });
}

export default function Composer({
  id,
  conversationId,
  parentId,
  placeholder,
  label,
  sendLabel = "Send",
  autoFocus,
  compact,
  disabled,
  restoreOnFailure,
  onSend,
  onEditLast,
  onEscape,
  onTyping,
}: {
  id: string;
  conversationId: string;
  parentId: string | null;
  placeholder: string;
  label: string;
  sendLabel?: string;
  autoFocus?: boolean;
  compact?: boolean;
  disabled?: boolean;
  restoreOnFailure?: boolean;
  onSend: (text: string, mentions: Mention[]) => Promise<string | null>;
  onEditLast?: () => boolean;
  onEscape?: () => void;
  onTyping?: (typing: boolean) => void;
}) {
  const { viewer } = useChat();
  const input = useRef<HTMLTextAreaElement>(null);
  const key = draftKey(viewer.id, conversationId, parentId);
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (hydrated && loaded !== key) {
    const draft = readDraft(key);
    setLoaded(key);
    setValue(draft.text);
    setMentions(draft.mentions);
  }
  const length = value.trim() ? messageBody(value, mentions).length : 0;
  const over = length > CHAT_BODY_MAX;

  useEffect(() => {
    if (!autoFocus || !window.matchMedia("(pointer: fine)").matches) return;
    const timer = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [autoFocus, key]);

  function change(next: string, kept: Mention[]) {
    setValue(next);
    setMentions(kept);
    setFailure(null);
    writeDraft(key, { text: next, mentions: kept });
    onTyping?.(next.trim().length > 0);
  }

  function send() {
    if (!value.trim() || disabled || over) return;
    const text = value;
    const sent = mentions;
    setValue("");
    setMentions([]);
    setFailure(null);
    onTyping?.(false);
    input.current?.focus({ preventScroll: true });
    void onSend(text, sent).then((error) => {
      if (!error || !restoreOnFailure) return;
      setFailure(error);
      setValue((current) => (current ? current : text));
      setMentions((current) => (current.length ? current : sent));
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        data-chat-composer
        className={cn(
          "border-line-strong bg-secondary focus-within:border-ring flex items-end gap-2 border py-1.5 pr-1.5 pl-3.5",
          compact ? "rounded-xl" : "rounded-2xl",
          over && "border-danger focus-within:border-danger",
        )}
        onClick={(event) => {
          if (event.target === event.currentTarget) input.current?.focus();
        }}
      >
        <div className="min-w-0 flex-1 py-[3px]">
          <MentionInput
            id={id}
            inputRef={input}
            value={value}
            mentions={mentions}
            placeholder={placeholder}
            ariaLabel={label}
            autoSize={GROW_MAX_PX}
            onChange={change}
            onSubmit={send}
            onBlur={() => onTyping?.(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && value === "" && onEscape) {
                event.preventDefault();
                onEscape();
                return;
              }
              if (event.key === "ArrowUp" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && value === "" && onEditLast?.()) {
                event.preventDefault();
              }
            }}
          />
        </div>
        <Button
          variant="primary"
          size="icon"
          aria-label={sendLabel}
          title={`${sendLabel} (Enter)`}
          disabled={!value.trim() || disabled || over}
          onMouseDown={(event) => event.preventDefault()}
          onClick={send}
          className="max-md:size-11"
        >
          <ArrowUpIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {over && (
        <p role="status" className="caption-style text-danger px-1">
          Messages can be up to {CHAT_BODY_MAX.toLocaleString("en-GB")} characters. This one is {length.toLocaleString("en-GB")}.
        </p>
      )}
      {failure && (
        <p role="alert" className="caption-style text-danger px-1">
          {failure}
        </p>
      )}
    </div>
  );
}
