"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import MentionInput from "@/components/assistant/mention-input";
import { draftKey, readDraft, writeDraft } from "@/lib/chat/client";
import type { Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";

function subscribeNothing() {
  return () => {};
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
  onSend,
  onEditLast,
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
  onSend: (text: string, mentions: Mention[]) => void;
  onEditLast?: () => boolean;
  onTyping?: (typing: boolean) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const key = draftKey(conversationId, parentId);
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (hydrated && loaded !== key) {
    const draft = readDraft(key);
    setLoaded(key);
    setValue(draft.text);
    setMentions(draft.mentions);
  }

  useEffect(() => {
    if (!autoFocus || !window.matchMedia("(pointer: fine)").matches) return;
    const timer = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [autoFocus, key]);

  function change(next: string, kept: Mention[]) {
    setValue(next);
    setMentions(kept);
    writeDraft(key, { text: next, mentions: kept });
    onTyping?.(next.trim().length > 0);
  }

  function send() {
    if (!value.trim() || disabled) return;
    onSend(value, mentions);
    setValue("");
    setMentions([]);
    writeDraft(key, { text: "", mentions: [] });
    onTyping?.(false);
    input.current?.focus({ preventScroll: true });
  }

  return (
    <div
      className={cn(
        "border-line-strong bg-secondary focus-within:border-ring flex items-end gap-2 border py-1.5 pr-1.5 pl-3.5",
        compact ? "rounded-xl" : "rounded-2xl",
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
          onChange={change}
          onSubmit={send}
          onBlur={() => onTyping?.(false)}
          onKeyDown={(event) => {
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
        disabled={!value.trim() || disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={send}
        className="max-md:size-9"
      >
        <ArrowUpIcon aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}
