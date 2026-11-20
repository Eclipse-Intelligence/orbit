"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MentionList, ROOM_OPTION, useMentionOptions, type MentionQuery } from "@/components/assistant/mention-list";
import { mentionEdit, type FormatAction } from "@/lib/chat/compose";
import type { FormatKind } from "@/lib/chat/markdown";
import {
  activeFormats,
  chatEditorExtensions,
  chatInputSettings,
  currentLink,
  fromProps,
  inCodeAt,
  inCodeBlock,
  inlineToggle,
  lineToggle,
  linkEdit,
  loadMarkdown,
  mentionLabels,
  newline,
  reloadMarkdown,
  richField,
  runSpec,
  stateMarkdown,
} from "@/lib/chat/rich-editor";
import { tightenAt } from "@/lib/chat/rich-text";
import type { MentionOption } from "@/lib/crm/mention-search";
import { liveMentions, type Mention } from "@/lib/mentions";
import { pickedMention, stripMention } from "@/lib/task-pad";

export const CHAT_INPUT = "[data-chat-input]";

export type ChatCaret = {
  text: string;
  caret: number;
  empty: boolean;
  focused: boolean;
  formats: Set<FormatKind>;
  inCode: boolean;
  inCodeBlock: boolean;
};

export type LinkTarget = {
  from: number;
  to: number;
  text: string;
  href: string | null;
};

export type ChatInputHandle = {
  focus: () => void;
  caretToEnd: () => void;
  run: (action: Exclude<FormatAction, "link">) => void;
  insert: (text: string, range?: { start: number; end: number }) => void;
  mention: () => void;
  linkTarget: () => LinkTarget | null;
  setLink: (target: { from: number; to: number; href: string | null; text?: string }) => void;
};

const NO_FORMATS = new Set<FormatKind>();

function chatView(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement) || !element.matches(CHAT_INPUT)) return null;
  return EditorView.findFromDOM(element);
}

export function chatInputText(element: Element | null | undefined) {
  return chatView(element)?.state.doc.toString() ?? null;
}

export function caretToEnd(element: Element | null | undefined) {
  const view = chatView(element);
  if (!view || document.activeElement !== element) return;
  view.dispatch({
    selection: EditorSelection.cursor(view.state.doc.length),
    scrollIntoView: true,
  });
}

function composing(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229;
}

function contentAttributes(options: { expanded: boolean; listId: string }) {
  return EditorView.contentAttributes.of({
    "aria-expanded": options.expanded ? "true" : "false",
    "aria-autocomplete": "list",
    role: "combobox",
    ...(options.expanded ? { "aria-controls": options.listId } : {}),
  });
}

export default function ChatInput({
  id,
  handle,
  value,
  mentions,
  placeholder,
  ariaLabel,
  autoFocus,
  roomMention,
  onChange,
  onSubmit,
  onBlur,
  onKeyDown,
  onCaret,
  onPaste,
  onReload,
  enterKeyHint = "send",
}: {
  id: string;
  handle: Ref<ChatInputHandle>;
  value: string;
  mentions: Mention[];
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  roomMention?: boolean;
  onChange: (value: string, mentions: Mention[]) => void;
  onSubmit: () => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onCaret?: (caret: ChatCaret) => void;
  onPaste?: (event: ClipboardEvent) => boolean;
  onReload?: () => void;
  enterKeyHint?: "send" | "done";
}) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const emitted = useRef(value);
  const echoes = useRef<string[]>([]);
  const known = useRef(mentions);
  const picked = useRef<Mention[]>([]);
  const initial = useRef({ value, placeholder, ariaLabel, id, autoFocus, enterKeyHint });
  const settings = useRef(new Compartment());
  const labels = useRef(new Compartment());
  const aria = useRef(new Compartment());
  const [open, setOpen] = useState<MentionQuery | null>(null);
  const { options, highlight, setHighlight, clear } = useMentionOptions(open, undefined, roomMention);
  const listId = `${id}-mentions`;
  const showList = open !== null && options.length > 0;
  const latest = useRef({
    onChange,
    onSubmit,
    onBlur,
    onKeyDown,
    onCaret,
    onPaste,
    onReload,
    open,
    options,
    highlight,
    pick: (() => undefined) as (option: MentionOption) => void,
  });

  function refresh(state: EditorState, focused: boolean) {
    const range = state.selection.main;
    const text = state.doc.toString();
    const found = focused && range.empty ? stripMention(text, range.head) : null;
    const tagged = found && [...known.current, ...picked.current].some((mention) => text.startsWith(`@${mention.name}`, found.start));
    const next = found && !tagged ? found : null;
    setOpen((current) => (current && next && current.start === next.start && current.end === next.end && current.query === next.query ? current : next));
  }

  function pick(option: MentionOption) {
    const view = viewRef.current;
    if (!view || !open) return;
    const text = view.state.doc.toString();
    const rest = text.slice(open.end);
    const { inserted, after } = pickedMention(option.name, rest);
    if (option === ROOM_OPTION) picked.current = [...picked.current.slice(-20), ROOM_OPTION];
    else {
      const chosen: Mention = {
        kind: option.kind,
        id: option.id,
        name: option.name,
      };
      picked.current = [...picked.current.slice(-20), chosen];
      known.current = [...known.current.filter((mention) => mention.id !== option.id), chosen];
    }
    setOpen(null);
    clear();
    view.dispatch({
      changes: {
        from: open.start,
        to: open.end + rest.length - after.length,
        insert: inserted,
      },
      selection: EditorSelection.cursor(open.start + inserted.length),
      userEvent: "input.complete",
      scrollIntoView: true,
    });
    view.focus();
  }

  useLayoutEffect(() => {
    known.current = mentions;
    latest.current = {
      onChange,
      onSubmit,
      onBlur,
      onKeyDown,
      onCaret,
      onPaste,
      onReload,
      open,
      options,
      highlight,
      pick,
    };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const start = initial.current;
    const base = EditorState.create({
      doc: "",
      extensions: [
        chatEditorExtensions(),
        settings.current.of(
          chatInputSettings({
            placeholder: start.placeholder,
            label: start.ariaLabel,
            id: start.id,
            enterKeyHint: start.enterKeyHint,
          }),
        ),
        labels.current.of(mentionLabels.of({ names: [], room: false })),
        aria.current.of(
          contentAttributes({
            expanded: false,
            listId: `${start.id}-mentions`,
          }),
        ),
        EditorState.transactionFilter.of((tr) => {
          if (!tr.docChanged || !tr.isUserEvent("input")) return tr;
          const text = tr.newDoc.toString();
          const names = known.current.map((mention) => mention.name);
          const removals: number[] = [];
          tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
            if (toB <= fromB) return;
            const at = tightenAt(text, fromB, names);
            if (at >= 0) removals.push(at);
          });
          return removals.length
            ? [
                tr,
                {
                  changes: removals.map((at) => ({ from: at, to: at + 1 })),
                  sequential: true,
                },
              ]
            : tr;
        }),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, view) {
              const now = latest.current;
              if (now.open && now.options.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlight((current) => (current + step + now.options.length) % now.options.length);
                  return true;
                }
                if ((event.key === "Enter" && !composing(event)) || event.key === "Tab") {
                  event.preventDefault();
                  now.pick(now.options[Math.min(now.highlight, now.options.length - 1)]);
                  return true;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(null);
                  return true;
                }
              }
              now.onKeyDown?.(event);
              if (event.defaultPrevented) return true;
              if (composing(event) || event.key !== "Enter") return false;
              event.preventDefault();
              if (event.shiftKey) return runSpec(view, newline(view.state));
              if (!event.altKey && inCodeBlock(view.state) && view.state.selection.main.empty) return runSpec(view, newline(view.state, { exitCode: true }));
              now.onSubmit();
              return true;
            },
            paste(event) {
              return latest.current.onPaste?.(event) ?? false;
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          const state = update.state;
          const restyled = update.startState.field(richField) !== state.field(richField);
          if (update.docChanged || restyled) {
            const loaded = update.transactions.some((transaction) => transaction.annotation(fromProps));
            if (!loaded) {
              const markdown = stateMarkdown(state);
              if (markdown !== emitted.current) {
                emitted.current = markdown;
                echoes.current = [...echoes.current.slice(-50), markdown];
                latest.current.onChange(markdown, liveMentions(markdown, known.current));
              }
            }
          }
          if (update.docChanged || restyled || update.selectionSet || update.focusChanged) {
            const focused = update.view.hasFocus;
            const range = state.selection.main;
            refresh(state, focused);
            latest.current.onCaret?.({
              text: state.doc.toString(),
              caret: range.head,
              empty: range.empty,
              focused,
              formats: focused ? activeFormats(state) : NO_FORMATS,
              inCode: inCodeAt(state, range.head),
              inCodeBlock: inCodeBlock(state),
            });
          }
          if (update.focusChanged && !update.view.hasFocus) {
            window.setTimeout(() => setOpen(null), 150);
            latest.current.onBlur?.();
          }
        }),
      ],
    });
    const view = new EditorView({
      parent,
      state: base.update(loadMarkdown(base, start.value)).state,
    });
    viewRef.current = view;
    if (start.autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [setHighlight]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const echo = echoes.current.indexOf(value);
    if (echo >= 0) {
      echoes.current = echoes.current.slice(echo + 1);
      return;
    }
    if (value === stateMarkdown(view.state)) return;
    echoes.current = [];
    emitted.current = value;
    for (const spec of reloadMarkdown(view.state, value)) view.dispatch(spec);
    latest.current.onReload?.();
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: settings.current.reconfigure(chatInputSettings({ placeholder, label: ariaLabel, id, enterKeyHint })),
    });
  }, [placeholder, ariaLabel, id, enterKeyHint]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: labels.current.reconfigure(
        mentionLabels.of({
          names: mentions.map((mention) => mention.name),
          room: Boolean(roomMention),
        }),
      ),
    });
  }, [mentions, roomMention]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: aria.current.reconfigure(contentAttributes({ expanded: showList, listId })),
    });
  }, [showList, listId]);

  useImperativeHandle(
    handle,
    () => ({
      focus: () => viewRef.current?.focus(),
      caretToEnd: () => {
        const view = viewRef.current;
        if (!view || !view.hasFocus) return;
        view.dispatch({
          selection: EditorSelection.cursor(view.state.doc.length),
          scrollIntoView: true,
        });
      },
      run: (action) => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        if (action === "bullets" || action === "numbers" || action === "quote") runSpec(view, lineToggle(view.state, action));
        else if (action === "codeBlock") runSpec(view, lineToggle(view.state, "code"));
        else runSpec(view, inlineToggle(view.state, action));
      },
      insert: (text, range) => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        const from = range?.start ?? view.state.selection.main.from;
        const to = range?.end ?? view.state.selection.main.to;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: EditorSelection.cursor(from + text.length),
          userEvent: "input.type",
          scrollIntoView: true,
        });
      },
      mention: () => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        const range = view.state.selection.main;
        const edit = mentionEdit(view.state.doc.toString(), range.from, range.to);
        view.dispatch({
          changes: { from: edit.start, to: edit.end, insert: edit.text },
          selection: EditorSelection.cursor(edit.selectionStart),
          userEvent: "input.type",
          scrollIntoView: true,
        });
      },
      linkTarget: () => {
        const view = viewRef.current;
        if (!view) return null;
        const link = currentLink(view.state);
        if (link)
          return {
            from: link.from,
            to: link.to,
            text: view.state.sliceDoc(link.from, link.to),
            href: link.href ?? null,
          };
        const range = view.state.selection.main;
        let from = range.from;
        let to = range.to;
        while (from < to && /\s/.test(view.state.sliceDoc(from, from + 1))) from += 1;
        while (to > from && /\s/.test(view.state.sliceDoc(to - 1, to))) to -= 1;
        if (view.state.sliceDoc(from, to).includes("\n")) return null;
        return { from, to, text: view.state.sliceDoc(from, to), href: null };
      },
      setLink: (target) => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        runSpec(view, linkEdit(view.state, target));
      },
    }),
    [],
  );

  return (
    <div ref={box} className="relative min-w-0">
      <div ref={host} />
      {showList && <MentionList id={listId} anchor={box} options={options} highlight={highlight} listPlacement="above" onPick={pick} />}
    </div>
  );
}
