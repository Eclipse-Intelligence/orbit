"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import Button from "@/components/_ui/button";
import MentionInput from "@/components/assistant/mention-input";
import { useChat } from "@/components/chat/chat-context";
import { messageBody } from "@/components/chat/use-chat-actions";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { draftKey, formatBarDefault, readDraft, readFormatBar, subscribeFormatBar, writeDraft, writeFormatBar, type FormatScope } from "@/lib/chat/client";
import { applyEdit, formatEdit, mentionEdit, type FormatAction, type TextEdit } from "@/lib/chat/compose";
import { insideCodeFence, markdownMarks } from "@/lib/chat/markdown";
import { CHAT_BODY_MAX } from "@/lib/chat/types";
import { liveMentions, type Mention } from "@/lib/mentions";
import { physicalComboMatches, SHORTCUT_BY_ID } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";
import AtIcon from "@/public/assets/images/chat/at.svg";
import BoldIcon from "@/public/assets/images/chat/bold.svg";
import CodeBlockIcon from "@/public/assets/images/chat/code-block.svg";
import CodeIcon from "@/public/assets/images/chat/code.svg";
import ItalicIcon from "@/public/assets/images/chat/italic.svg";
import LinkIcon from "@/public/assets/images/chat/link.svg";
import BulletsIcon from "@/public/assets/images/chat/list-bullets.svg";
import NumbersIcon from "@/public/assets/images/chat/list-numbers.svg";
import QuoteIcon from "@/public/assets/images/chat/quote.svg";
import StrikeIcon from "@/public/assets/images/chat/strikethrough.svg";

const GROW_MAX_PX = 200;
const MARK_CLASS = "bg-transparent text-faint";

type Tool = { action: FormatAction; label: string; shortcut: string; Icon: typeof BoldIcon };

const TOOLS: Tool[][] = [
  [
    { action: "bold", label: "Bold", shortcut: "chat-bold", Icon: BoldIcon },
    { action: "italic", label: "Italic", shortcut: "chat-italic", Icon: ItalicIcon },
    { action: "strike", label: "Strikethrough", shortcut: "chat-strike", Icon: StrikeIcon },
  ],
  [{ action: "link", label: "Link", shortcut: "chat-link", Icon: LinkIcon }],
  [
    { action: "bullets", label: "Bulleted list", shortcut: "chat-bullets", Icon: BulletsIcon },
    { action: "numbers", label: "Numbered list", shortcut: "chat-numbers", Icon: NumbersIcon },
  ],
  [
    { action: "code", label: "Code", shortcut: "chat-code", Icon: CodeIcon },
    { action: "codeBlock", label: "Code block", shortcut: "", Icon: CodeBlockIcon },
    { action: "quote", label: "Quote", shortcut: "chat-quote", Icon: QuoteIcon },
  ],
];

const SHORTCUT_ACTIONS = TOOLS.flat().filter((tool) => tool.shortcut);

function subscribeNothing() {
  return () => {};
}

function isMac() {
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

function composing(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export function caretToEnd(area: HTMLTextAreaElement | null | undefined) {
  if (!area || document.activeElement !== area) return;
  area.setSelectionRange(area.value.length, area.value.length);
}

export function focusComposer(from: Element | null) {
  const scope = from?.closest("[data-chat-room-pane], [data-chat-thread-pane]") ?? document;
  scope.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.focus({ preventScroll: true });
}

function useFormatBar(userId: string, scope: FormatScope) {
  const shown = useSyncExternalStore(
    subscribeFormatBar,
    () => readFormatBar(userId, scope),
    () => formatBarDefault(scope),
  );
  return [shown, (next: boolean) => writeFormatBar(userId, scope, next)] as const;
}

function ToolButton({ tool, onRun, phone }: { tool: Tool; onRun: (action: FormatAction) => void; phone?: boolean }) {
  const hint = useShortcutHint(tool.shortcut);
  return (
    <Button
      variant="ghost"
      size="none"
      aria-label={tool.label}
      title={hint ? `${tool.label} (${hint})` : tool.label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun(tool.action)}
      className={cn("shrink-0 rounded-md", phone ? "size-11" : "h-[26px] w-7 pointer-coarse:size-11")}
    >
      <tool.Icon aria-hidden className={phone ? "size-4" : "size-3.5"} />
    </Button>
  );
}

function Toolbar({ onRun, phone, className }: { onRun: (action: FormatAction) => void; phone?: boolean; className?: string }) {
  return (
    <div role="toolbar" aria-label="Formatting" className={cn("flex items-center gap-px", className)}>
      {TOOLS.map((group, index) => (
        <div key={index} className="flex items-center gap-px">
          {index > 0 && <span aria-hidden className="bg-line-strong mx-1 h-3.5 w-px shrink-0" />}
          {group.map((tool) => (
            <ToolButton key={tool.action} tool={tool} onRun={onRun} phone={phone} />
          ))}
        </div>
      ))}
    </div>
  );
}

function FormatToggle({ shown, onToggle, phone }: { shown: boolean; onToggle: () => void; phone?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="none"
      aria-label="Formatting"
      aria-pressed={shown}
      title={shown ? "Hide formatting" : "Show formatting"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        "aria-pressed:bg-surface-active aria-pressed:text-foreground shrink-0 rounded-md px-2 text-[13px] font-medium",
        phone ? "h-11 min-w-11" : "h-[30px] pointer-coarse:h-11 pointer-coarse:min-w-11",
      )}
    >
      Aa
    </Button>
  );
}

export function ComposerBox({
  id,
  inputRef,
  value,
  mentions,
  placeholder,
  label,
  scope,
  over,
  composer,
  autoFocus,
  actions,
  phoneAction,
  onChange,
  onSubmit,
  onKeyDown,
  onBlur,
}: {
  id: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  mentions: Mention[];
  placeholder: string;
  label: string;
  scope: FormatScope;
  over?: boolean;
  composer?: boolean;
  autoFocus?: boolean;
  actions: ReactNode;
  phoneAction?: ReactNode;
  onChange: (value: string, mentions: Mention[]) => void;
  onSubmit: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
}) {
  const { viewer } = useChat();
  const [shown, setShown] = useFormatBar(viewer.id, scope);
  const [focused, setFocused] = useState(false);
  const marks = useMemo(() => markdownMarks(value).map((mark) => ({ ...mark, className: MARK_CLASS })), [value]);
  const oneRow = Boolean(phoneAction);

  function apply(edit: TextEdit) {
    const area = inputRef.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(edit.start, edit.end);
    let inserted = false;
    try {
      inserted = edit.text ? document.execCommand("insertText", false, edit.text) : document.execCommand("delete");
    } catch {
      inserted = false;
    }
    if (inserted && area.value === applyEdit(value, edit)) {
      area.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      return;
    }
    const next = applyEdit(value, edit);
    onChange(next, liveMentions(next, mentions));
    window.requestAnimationFrame(() => area.setSelectionRange(edit.selectionStart, edit.selectionEnd));
  }

  function run(action: FormatAction) {
    const area = inputRef.current;
    if (!area) return;
    apply(formatEdit(value, area.selectionStart, area.selectionEnd, action));
  }

  function mention() {
    const area = inputRef.current;
    if (!area) return;
    apply(mentionEdit(value, area.selectionStart, area.selectionEnd));
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing(event)) {
      onKeyDown?.(event);
      return;
    }
    const mac = isMac();
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey) {
      const tool = SHORTCUT_ACTIONS.find((item) => SHORTCUT_BY_ID.get(item.shortcut)?.combos?.some((combo) => physicalComboMatches(combo, event, mac)));
      if (tool) {
        event.preventDefault();
        run(tool.action);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSubmit();
        return;
      }
    }
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !mod && !event.altKey && insideCodeFence(value, event.currentTarget.selectionStart)) {
      event.preventDefault();
      const area = event.currentTarget;
      apply({ start: area.selectionStart, end: area.selectionEnd, text: "\n", selectionStart: area.selectionStart + 1, selectionEnd: area.selectionStart + 1 });
    }
  }

  function blur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setFocused(false);
  }

  const iconButton = "size-[30px] shrink-0 rounded-md pointer-coarse:size-11";

  return (
    <div className="flex flex-col" onFocus={() => setFocused(true)} onBlur={blur}>
      <div
        data-chat-composer={composer ? "" : undefined}
        className={cn(
          "border-line-strong bg-secondary focus-within:border-ring flex flex-col rounded-lg border",
          oneRow && "max-md:rounded-[22px]",
          over && "border-danger focus-within:border-danger",
        )}
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        {shown && <Toolbar onRun={run} className="border-line-subtle border-b px-1.5 py-1 max-md:hidden" />}
        <div className="flex items-end gap-2">
          <div className={cn("min-w-0 flex-1 px-3.5 pt-2.5 pb-1", oneRow && "max-md:py-[9px] max-md:pl-4")}>
            <MentionInput
              id={id}
              inputRef={inputRef}
              value={value}
              mentions={mentions}
              marks={marks}
              placeholder={placeholder}
              ariaLabel={label}
              autoFocus={autoFocus}
              autoSize={GROW_MAX_PX}
              onChange={onChange}
              onSubmit={onSubmit}
              onBlur={onBlur}
              onKeyDown={keyDown}
            />
          </div>
          {oneRow && <div className="shrink-0 p-[3px] md:hidden">{phoneAction}</div>}
        </div>
        <div className={cn("flex items-center gap-0.5 px-1.5 pt-0.5 pb-1.5", oneRow && "max-md:hidden")}>
          <Button variant="ghost" size="none" aria-label="Mention someone" title="Mention someone" onMouseDown={(event) => event.preventDefault()} onClick={mention} className={iconButton}>
            <AtIcon aria-hidden className="size-3.5" />
          </Button>
          <span aria-hidden className="bg-line-strong mx-1 h-4 w-px shrink-0 max-md:hidden" />
          <span className="max-md:hidden">
            <FormatToggle shown={shown} onToggle={() => setShown(!shown)} />
          </span>
          <span className="flex-1" />
          {actions}
        </div>
      </div>
      {focused && (
        <div className="bg-popover border-line-subtle -mx-2 mt-2 flex items-center gap-0.5 overflow-x-auto overscroll-contain border-t px-1.5 py-1 md:hidden">
          <FormatToggle shown={shown} onToggle={() => setShown(!shown)} phone />
          {shown && <Toolbar onRun={run} phone />}
        </div>
      )}
    </div>
  );
}

export default function Composer({
  id,
  conversationId,
  parentId,
  placeholder,
  label,
  sendLabel = "Send",
  scope = "room",
  autoFocus,
  disabled,
  restoreOnFailure,
  hideFailure,
  fallbackDraft,
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
  scope?: FormatScope;
  autoFocus?: boolean;
  disabled?: boolean;
  restoreOnFailure?: boolean;
  hideFailure?: boolean;
  fallbackDraft?: { text: string; mentions: Mention[] } | null;
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
    const stored = readDraft(key);
    const draft = !stored.text.trim() && fallbackDraft?.text.trim() ? fallbackDraft : stored;
    setLoaded(key);
    setValue(draft.text);
    setMentions(draft.mentions);
  }
  const length = value.trim() ? messageBody(value, mentions).length : 0;
  const over = length > CHAT_BODY_MAX;
  const blocked = !value.trim() || disabled || over;

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
    if (blocked) return;
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
      window.requestAnimationFrame(() => caretToEnd(input.current));
    });
  }

  function sendButton(phone: boolean) {
    return (
      <Button
        variant="primary"
        size="icon"
        aria-label={sendLabel}
        title={`${sendLabel} (Enter)`}
        disabled={blocked}
        onMouseDown={(event) => event.preventDefault()}
        onClick={send}
        className={cn("hit", phone ? "size-[38px] rounded-full" : "w-[34px] pointer-coarse:size-11")}
      >
        <ArrowUpIcon aria-hidden className="size-3.5" />
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <ComposerBox
        id={id}
        inputRef={input}
        value={value}
        mentions={mentions}
        placeholder={placeholder}
        label={label}
        scope={scope}
        over={over}
        composer
        actions={sendButton(false)}
        phoneAction={sendButton(true)}
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
      {over && (
        <p role="status" className="caption-style text-danger px-1">
          Messages can be up to {CHAT_BODY_MAX.toLocaleString("en-GB")} characters. This one is {length.toLocaleString("en-GB")}.
        </p>
      )}
      {failure && !hideFailure && (
        <p role="alert" className="caption-style text-danger px-1">
          {failure}
        </p>
      )}
    </div>
  );
}
