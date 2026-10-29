import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { previewPlan } from "@/lib/docs/editor/plan";
import { refreshPreview } from "@/lib/docs/editor/preview";
import { segmentsBetween, type InlineItem, type StaticSegment } from "@/lib/docs/editor/segments";
import { MentionWidget } from "@/lib/docs/editor/widgets";

export type TableAlign = "left" | "center" | "right" | null;

export type CellRange = { from: number; to: number };

export type TableBlock = {
  from: number;
  to: number;
  align: TableAlign[];
  header: CellRange[];
  rows: CellRange[][];
};

export type TableCell = { segments: StaticSegment[] };

export type TableView = {
  from: number;
  to: number;
  align: TableAlign[];
  header: TableCell[];
  rows: TableCell[][];
};

const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

export function splitRow(row: string): CellRange[] {
  const pipes: number[] = [];
  let escaped = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "|" && !escaped) pipes.push(index);
    escaped = !escaped && char === "\\";
  }
  const bounds = [-1, ...pipes, row.length];
  const pieces: CellRange[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) pieces.push({ from: bounds[index] + 1, to: bounds[index + 1] });
  const blank = (piece: CellRange) => !row.slice(piece.from, piece.to).trim();
  if (pipes.length && pieces.length && blank(pieces[0])) pieces.shift();
  if (pipes.length && pieces.length && blank(pieces[pieces.length - 1])) pieces.pop();
  return pieces.map((piece) => {
    let from = piece.from;
    let to = piece.to;
    while (from < to && /\s/.test(row[from])) from += 1;
    while (to > from && /\s/.test(row[to - 1])) to -= 1;
    return { from, to };
  });
}

export function alignmentOf(cell: string): TableAlign {
  const text = cell.trim();
  const left = text.startsWith(":");
  const right = text.length > 1 && text.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

export function tableAlignments(delimiter: string): TableAlign[] {
  return splitRow(delimiter).map((cell) => alignmentOf(delimiter.slice(cell.from, cell.to)));
}

function rowCells(doc: Text, node: SyntaxNode): CellRange[] {
  return splitRow(doc.sliceString(node.from, node.to)).map((cell) => ({ from: node.from + cell.from, to: node.from + cell.to }));
}

function tableBlock(doc: Text, node: SyntaxNode): TableBlock | null {
  const headerNode = node.getChild("TableHeader");
  if (!headerNode) return null;
  const header = rowCells(doc, headerNode);
  if (!header.length) return null;
  let delimiter: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter" && doc.lineAt(child.from).number !== doc.lineAt(headerNode.from).number) {
      delimiter = child;
      break;
    }
  }
  const declared = delimiter ? tableAlignments(doc.sliceString(delimiter.from, delimiter.to)) : [];
  const align = header.map((_, index) => declared[index] ?? null);
  const rows = node.getChildren("TableRow").map((row) => {
    const cells = rowCells(doc, row).slice(0, header.length);
    while (cells.length < header.length) cells.push({ from: row.to, to: row.to });
    return cells;
  });
  return { from: doc.lineAt(node.from).from, to: doc.lineAt(node.to).to, align, header, rows };
}

export function findTables(doc: Text, tree: Tree, from = 0, to = doc.length): TableBlock[] {
  const blocks: TableBlock[] = [];
  tree.iterate({
    from,
    to,
    enter(ref) {
      if (ref.name === "Table") {
        const block = tableBlock(doc, ref.node);
        if (block) blocks.push(block);
        return false;
      }
      return CONTAINERS.has(ref.name);
    },
  });
  return blocks;
}

function unescapePipes(segments: StaticSegment[]): StaticSegment[] {
  return segments.map((segment) => ("text" in segment ? { ...segment, text: segment.text.replace(/\\\|/g, "|") } : segment));
}

export function tableViews({ doc, tree, from = 0, to = doc.length, resolve }: { doc: Text; tree: Tree; from?: number; to?: number; resolve: (target: string) => boolean }): TableView[] {
  const text = doc.toString();
  return findTables(doc, tree, from, to).map((block) => {
    const items = previewPlan({ doc, tree, from: block.from, to: block.to, active: new Set(), daily: false, resolve }).filter(
      (item): item is InlineItem => item.type !== "line",
    );
    const cell = (range: CellRange): TableCell => ({ segments: unescapePipes(segmentsBetween(text, items, range.from, range.to)) });
    return { from: block.from, to: block.to, align: block.align, header: block.header.map(cell), rows: block.rows.map((row) => row.map(cell)) };
  });
}

export function alignClass(align: TableAlign) {
  return align === "center" ? "is-center" : align === "right" ? "is-right" : "";
}

function segmentNode(segment: StaticSegment): Node | null {
  if ("widget" in segment) {
    const spec = segment.widget;
    return spec.kind === "mention" ? new MentionWidget(spec.name, spec.mentionKind, spec.id).toDOM() : null;
  }
  if (!segment.className && !segment.attributes) return document.createTextNode(segment.text);
  const node = document.createElement("span");
  if (segment.className) node.className = segment.className;
  for (const [name, value] of Object.entries(segment.attributes ?? {})) node.setAttribute(name, value);
  node.textContent = segment.text;
  return node;
}

function cellNode(tag: "th" | "td", cell: TableCell, align: TableAlign, row: number, column: number) {
  const node = document.createElement(tag);
  const className = alignClass(align);
  if (className) node.className = className;
  if (tag === "th") node.setAttribute("scope", "col");
  node.dataset.row = String(row);
  node.dataset.column = String(column);
  const inner = document.createElement("span");
  inner.className = "note-table-cell";
  for (const segment of cell.segments) {
    const child = segmentNode(segment);
    if (child) inner.append(child);
  }
  node.append(inner);
  return node;
}

function signature(table: TableView) {
  return JSON.stringify([table.align, table.header, table.rows]);
}

class TableWidget extends WidgetType {
  readonly key: string;
  constructor(readonly table: TableView) {
    super();
    this.key = signature(table);
  }
  eq(other: TableWidget) {
    return other.key === this.key;
  }
  toDOM() {
    const holder = document.createElement("div");
    holder.className = "note-table-widget";
    const scroller = document.createElement("div");
    scroller.className = "note-table-scroll";
    const table = document.createElement("table");
    table.className = "note-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.table.header.forEach((cell, column) => headRow.append(cellNode("th", cell, this.table.align[column], 0, column)));
    head.append(headRow);
    table.append(head);
    if (this.table.rows.length) {
      const body = document.createElement("tbody");
      this.table.rows.forEach((row, index) => {
        const line = document.createElement("tr");
        row.forEach((cell, column) => line.append(cellNode("td", cell, this.table.align[column], index + 1, column)));
        body.append(line);
      });
      table.append(body);
    }
    scroller.append(table);
    holder.append(scroller);
    return holder;
  }
  get estimatedHeight() {
    return (this.table.rows.length + 1) * 38 + 16;
  }
  ignoreEvent(event: Event) {
    return event.type !== "mousedown";
  }
}

export const setTableFocus = StateEffect.define<boolean>();

const tableFocus = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setTableFocus)) return effect.value;
    return value;
  },
});

function touches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

const rawLine = Decoration.line({ class: "note-table-line" });

function buildTables(state: EditorState, resolve: (target: string) => boolean): DecorationSet {
  const focused = state.field(tableFocus, false) ?? false;
  const ranges: Range<Decoration>[] = [];
  for (const table of tableViews({ doc: state.doc, tree: syntaxTree(state), resolve })) {
    if (focused && touches(state, table.from, table.to)) {
      const last = state.doc.lineAt(table.to).number;
      for (let number = state.doc.lineAt(table.from).number; number <= last; number += 1) ranges.push(rawLine.range(state.doc.line(number).from));
      continue;
    }
    ranges.push(Decoration.replace({ widget: new TableWidget(table), block: true }).range(table.from, table.to));
  }
  return Decoration.set(ranges, true);
}

export function tableAt(state: EditorState, pos: number) {
  return findTables(state.doc, syntaxTree(state), pos, pos).find((block) => block.from <= pos && block.to >= pos) ?? null;
}

const LINKS = "[data-mention-id], .note-wikilink, .note-tag, .note-link";

function editTable(event: MouseEvent, view: EditorView) {
  if (event.button !== 0 || view.state.readOnly) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const holder = target?.closest<HTMLElement>(".note-table-widget");
  if (!target || !holder || target.closest(LINKS)) return false;
  const block = tableAt(view.state, view.posAtDOM(holder));
  if (!block) return false;
  const cell = target.closest<HTMLElement>("[data-row]");
  const row = Number(cell?.dataset.row ?? 0);
  const column = Number(cell?.dataset.column ?? 0);
  const range = (row === 0 ? block.header : block.rows[row - 1])?.[column];
  event.preventDefault();
  view.focus();
  view.dispatch({ selection: { anchor: range ? range.to : block.from }, effects: setTableFocus.of(true), userEvent: "select.pointer" });
  return true;
}

function enterTable(forward: boolean) {
  return (view: EditorView) => {
    const { state } = view;
    const range = state.selection.main;
    if (!range.empty || state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(range.head);
    const number = forward ? line.number + 1 : line.number - 1;
    if (number < 1 || number > state.doc.lines) return false;
    const block = tableAt(state, state.doc.line(number).from);
    if (!block || (range.head >= block.from && range.head <= block.to)) return false;
    view.dispatch({ selection: { anchor: forward ? block.from : state.doc.lineAt(block.to).from }, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

const focusSync = ViewPlugin.fromClass(
  class {
    live = true;
    constructor(view: EditorView) {
      this.sync(view);
    }
    update(update: { view: EditorView }) {
      this.sync(update.view);
    }
    destroy() {
      this.live = false;
    }
    sync(view: EditorView) {
      if (view.state.readOnly || view.hasFocus === view.state.field(tableFocus, false)) return;
      queueMicrotask(() => {
        if (this.live && view.hasFocus !== view.state.field(tableFocus, false)) view.dispatch({ effects: setTableFocus.of(view.hasFocus) });
      });
    }
  },
);

export function noteTables(options: { resolve: (target: string) => boolean }): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildTables(state, options.resolve),
    update(decorations, transaction) {
      const refreshed = transaction.effects.some((effect) => effect.is(setTableFocus) || effect.is(refreshPreview));
      if (transaction.docChanged || transaction.selection || refreshed || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
        return buildTables(transaction.state, options.resolve);
      }
      return decorations;
    },
    provide: (value) => EditorView.decorations.from(value),
  });
  return [
    tableFocus,
    field,
    focusSync,
    EditorView.focusChangeEffect.of((_state, focusing) => setTableFocus.of(focusing)),
    EditorView.domEventHandlers({ mousedown: editTable }),
    keymap.of([
      { key: "ArrowDown", run: enterTable(true) },
      { key: "ArrowUp", run: enterTable(false) },
    ]),
  ];
}
