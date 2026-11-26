import fontkit from "@pdf-lib/fontkit";
import type { SyntaxNode } from "@lezer/common";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { safeHref } from "@/lib/docs/editor/links";
import { docsParser } from "@/lib/docs/editor/syntax";
import { updatedLabel } from "@/lib/docs/public-link";
import { loadFonts } from "@/lib/proposals/pdf";

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };
type Style = { bold: boolean; italic: boolean; code: boolean; strike: boolean };
type Run = Style & { text: string };
type Word = { text: string; font: PDFFont; code: boolean; strike: boolean; units: number };
type Align = "left" | "center" | "right";
type Context = { indent: number; bars: number[] };
type Prepared = {
  laid: Word[][][][];
  widths: number[];
  pad: number;
  leading: number;
  headLines: number;
  headHeight: number;
  repeat: boolean;
  alignments: Align[];
  left: number;
  width: number;
  lead: number;
};

const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 56;
const BOTTOM = 64;
const TOP = HEIGHT - MARGIN;
const PAGE_ROOM = TOP - BOTTOM;
const BODY = 10.5;
const CODE = 9;
const CELL = 9;
const CELL_PAD = 5;
const CELL_VERTICAL = 4;
const MIN_TEXT = 160;
const MAX_DEPTH = 40;
const MAX_INDENT = WIDTH - MARGIN * 2 - MIN_TEXT;
const DEADLINE_MS = 20_000;
const FAILED = "Couldn't make the PDF. Try again.";
const INK = rgb(0.11, 0.11, 0.13);
const MUTED = rgb(0.42, 0.43, 0.47);
const RULE = rgb(0.86, 0.86, 0.89);
const WASH = rgb(0.955, 0.957, 0.965);
const MENTION_PATTERN = /^@\[([^[\]\n]{1,200})\]\(/;
const MARK = /Mark$/;
const MARK_KEPT = new Set(["Hashtag"]);
const NO_STYLE: Style = { bold: false, italic: false, code: false, strike: false };
const INVISIBLE = new Set([0xfe0e, 0xfe0f, 0x200d, 0x7f]);

export type DocPdfInput = { title: string; content: string; updatedAt: string | Date };

export class PdfDeadlineError extends Error {
  constructor() {
    super(FAILED);
  }
}

function plain(text: string, style: Partial<Style> = {}): Run {
  return { ...NO_STYLE, ...style, text };
}

const MENTION_SYNTAX = /@\[([^[\]\n]{1,200})\]\((?:contact|company|task|opportunity|proposal|member):[0-9a-f-]{36}\)/g;
const WIKILINK_SYNTAX = /\[\[([^[\]\n]{1,400}?)\]\]/g;
const LINK_SYNTAX = /!?\[([^\]\n]*)\]\((?:https?:\/\/|mailto:|www\.)[^)\n]*\)/g;
const HTML_TAG = /<\/?[A-Za-z][\w:-]*(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*\/?>|<!--[\s\S]*?-->|<![A-Za-z][^>\n]*>/g;
const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:/gm;

let definitions = new Set<string>();

function referenceKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function displayText(raw: string, links = true) {
  const shown = raw
    .replace(MENTION_SYNTAX, "$1")
    .replace(WIKILINK_SYNTAX, (_, inner: string) => (inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner));
  return links ? shown.replace(LINK_SYNTAX, "$1") : shown;
}

function linkResolves(text: string, node: SyntaxNode, marks: SyntaxNode[]) {
  const url = node.getChild("URL");
  if (url) return safeHref(text.slice(url.from, url.to)) !== null;
  const label = node.getChild("LinkLabel");
  const key = label && label.to - label.from > 2 ? text.slice(label.from + 1, label.to - 1) : text.slice(marks[0].to, marks[1].from);
  return definitions.has(referenceKey(key));
}

function inlineRuns(text: string, node: SyntaxNode, from: number, to: number, base: Style, out: Run[]) {
  const push = (value: string, style: Style = base) => {
    if (value) out.push({ ...style, text: value });
  };
  let at = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue;
    if (child.from >= to) break;
    if (child.from > at) push(displayText(text.slice(at, child.from)).replace(/\n[ \t]*/g, "\n"));
    at = Math.max(at, child.to);
    const name = child.name;
    if (MARK.test(name) && !MARK_KEPT.has(name)) continue;
    if (name === "TaskMarker") continue;
    if (name === "HardBreak") {
      push("\n");
    } else if (name === "Escape") {
      push(text.slice(child.from + 1, child.to));
    } else if (name === "StrongEmphasis") {
      inlineRuns(text, child, child.from, child.to, { ...base, bold: true }, out);
    } else if (name === "Emphasis") {
      inlineRuns(text, child, child.from, child.to, { ...base, italic: true }, out);
    } else if (name === "Strikethrough") {
      inlineRuns(text, child, child.from, child.to, { ...base, strike: true }, out);
    } else if (name === "InlineCode") {
      const marks = child.getChildren("CodeMark");
      const inner = marks.length >= 2 ? text.slice(marks[0].to, marks[marks.length - 1].from) : text.slice(child.from, child.to);
      push(inner.replace(/\s+/g, " "), { ...base, code: true });
    } else if (name === "Link" || name === "Image") {
      const marks = child.getChildren("LinkMark");
      if (marks.length >= 2 && linkResolves(text, child, marks)) inlineRuns(text, child, marks[0].to, marks[1].from, base, out);
      else push(displayText(text.slice(child.from, child.to), false));
    } else if (name === "WikiLink") {
      const inner = text.slice(child.from + 2, child.to - 2);
      const bar = inner.indexOf("|");
      push(bar >= 0 ? inner.slice(bar + 1) : inner);
    } else if (name === "Mention") {
      push(MENTION_PATTERN.exec(text.slice(child.from, child.to))?.[1] ?? "");
    } else if (child.firstChild && name !== "Hashtag" && name !== "URL") {
      inlineRuns(text, child, child.from, child.to, base, out);
    } else {
      push(displayText(text.slice(child.from, child.to)));
    }
  }
  if (at < to) push(displayText(text.slice(at, to)).replace(/\n[ \t]*/g, "\n"));
}

function runsOf(text: string, node: SyntaxNode, bold = false) {
  const out: Run[] = [];
  inlineRuns(text, node, node.from, node.to, { ...NO_STYLE, bold }, out);
  return out;
}

export class DocPdfWriter {
  private page: PDFPage;
  private y = TOP;
  private known: Set<number>;
  private units = new Map<PDFFont, Map<string, number>>();
  private tables = new Map<string, Prepared>();
  private depth = 0;

  constructor(
    private pdf: PDFDocument,
    private fonts: Fonts,
    private text: string,
    private deadline: number,
  ) {
    this.known = new Set(fonts.regular.getCharacterSet());
    this.page = this.addPage();
  }

  private tick() {
    if (Date.now() > this.deadline) throw new PdfDeadlineError();
  }

  private addPage() {
    this.tick();
    this.page = this.pdf.addPage([WIDTH, HEIGHT]);
    this.y = TOP;
    return this.page;
  }

  clean(value: string) {
    const out: string[] = [];
    for (const char of value.normalize("NFC")) {
      const point = char.codePointAt(0) ?? 0;
      if (char === "\n") out.push(char);
      else if (char === "\t") out.push("  ");
      else if (char === " " || char === " ") out.push(" ");
      else if (INVISIBLE.has(point) || (point >= 0x80 && point <= 0x9f)) continue;
      else if (point < 0x20) out.push(" ");
      else out.push(this.known.has(point) ? char : "?");
    }
    return out.join("");
  }

  private space(height: number) {
    if (this.y - height < BOTTOM && this.y < TOP - 0.5) this.addPage();
  }

  private gap(height: number) {
    this.y -= height;
  }

  private fontFor(style: Style) {
    return style.bold ? this.fonts.bold : style.italic ? this.fonts.italic : this.fonts.regular;
  }

  private unit(font: PDFFont, char: string) {
    let table = this.units.get(font);
    if (!table) {
      table = new Map();
      this.units.set(font, table);
    }
    let value = table.get(char);
    if (value === undefined) {
      value = font.widthOfTextAtSize(char, 1000);
      table.set(char, value);
    }
    return value;
  }

  private measure(font: PDFFont, value: string, size: number) {
    let sum = 0;
    for (const char of value) sum += this.unit(font, char);
    return (sum * size) / 1000;
  }

  private width(word: Word, size: number) {
    return (word.units * size) / 1000;
  }

  private word(text: string, font: PDFFont, style: Style, units = -1): Word {
    return { text, font, code: style.code, strike: style.strike, units: units >= 0 ? units : this.measure(font, text, 1000) };
  }

  layout(runs: Run[], size: number, width: number): Word[][] {
    const words: (Word | "\n")[] = [];
    for (const run of runs) {
      const font = this.fontFor(run);
      this.clean(run.text)
        .split("\n")
        .forEach((line, index) => {
          if (index > 0) words.push("\n");
          for (const piece of line.split(/(\s+)/)) {
            if (!piece) continue;
            const whole = this.word(piece, font, run);
            if ((whole.units * size) / 1000 <= width) {
              words.push(whole);
              continue;
            }
            let part = "";
            let partUnits = 0;
            for (const char of piece) {
              const unit = this.unit(font, char);
              if (part && ((partUnits + unit) * size) / 1000 > width) {
                words.push(this.word(part, font, run, partUnits));
                part = "";
                partUnits = 0;
              }
              part += char;
              partUnits += unit;
            }
            if (part) words.push(this.word(part, font, run, partUnits));
          }
        });
    }
    const lines: Word[][] = [];
    let line: Word[] = [];
    let used = 0;
    const close = () => {
      while (line.length && !line[line.length - 1].text.trim()) line.pop();
      lines.push(line);
      line = [];
      used = 0;
    };
    for (const word of words) {
      if (word === "\n") {
        close();
        continue;
      }
      const wide = this.width(word, size);
      const blank = !word.text.trim();
      if (!blank && used + wide > width && line.length) close();
      if (!line.length && blank) continue;
      line.push(word);
      used += wide;
    }
    if (line.length || lines.length === 0) close();
    while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
    return lines;
  }

  private lineWidth(line: Word[], size: number) {
    return line.reduce((sum, word) => sum + this.width(word, size), 0);
  }

  private drawLine(line: Word[], x: number, top: number, size: number, leading: number, color = INK, align: Align = "left", width = 0) {
    this.tick();
    const total = this.lineWidth(line, size);
    const offset = align === "right" ? width - total : align === "center" ? (width - total) / 2 : 0;
    let at = x + Math.max(0, offset);
    const baseline = top - size - (leading - size) / 2 + 1;
    for (let index = 0; index < line.length; ) {
      const first = line[index];
      let end = index;
      let text = "";
      let units = 0;
      while (end < line.length && line[end].font === first.font && line[end].code === first.code && line[end].strike === first.strike) {
        text += line[end].text;
        units += line[end].units;
        end += 1;
      }
      const wide = (units * size) / 1000;
      if (text.trim()) {
        if (first.code) this.page.drawRectangle({ x: at - 1, y: top - leading + 2, width: wide + 2, height: leading - 3, color: WASH });
        this.page.drawText(text, { x: at, y: baseline, size, font: first.font, color });
        if (first.strike) this.page.drawLine({ start: { x: at, y: baseline + size * 0.3 }, end: { x: at + wide, y: baseline + size * 0.3 }, thickness: 0.6, color });
      }
      at += wide;
      index = end;
    }
  }

  private bars(context: Context, top: number, height: number) {
    for (const x of context.bars) {
      this.page.drawLine({ start: { x, y: top }, end: { x, y: top - height }, thickness: 2, color: RULE });
    }
  }

  private paragraph(
    runs: Run[],
    context: Context,
    options: { size?: number; before?: number; after?: number; keep?: number; together?: boolean; marker?: (top: number, leading: number) => void } = {},
  ) {
    const size = options.size ?? BODY;
    const leading = size * 1.5;
    const lines = this.layout(runs, size, WIDTH - MARGIN * 2 - context.indent);
    if (lines.every((line) => line.length === 0)) return false;
    this.gap(options.before ?? 0);
    this.space((options.together ? lines.length * leading : leading) + (options.keep ?? 0));
    lines.forEach((line, index) => {
      this.space(leading);
      this.bars(context, this.y, leading);
      if (index === 0) options.marker?.(this.y, leading);
      this.drawLine(line, MARGIN + context.indent, this.y, size, leading);
      this.y -= leading;
    });
    this.gap(options.after ?? 0);
    return true;
  }

  private heading(node: SyntaxNode, level: number, context: Context) {
    const size = [0, 17, 14.5, 12.5, 11.5, 11, 10.5][Math.min(level, 6)];
    const next = node.nextSibling;
    const keep = next?.name === "Table" ? (this.prepareTable(next, context)?.lead ?? 40) : 40;
    this.paragraph(runsOf(this.text, node, true), context, { size, before: level <= 2 ? 10 : 6, after: 3, keep, together: true });
  }

  private code(node: SyntaxNode, context: Context) {
    const body = node.getChild("CodeText");
    const source = body ? this.text.slice(body.from, body.to) : "";
    const width = WIDTH - MARGIN * 2 - context.indent - 12;
    const leading = CODE * 1.5;
    const font = this.fonts.regular;
    this.gap(4);
    for (const raw of source.replace(/\s+$/, "").split("\n")) {
      const rows: string[] = [];
      let row = "";
      let rowUnits = 0;
      for (const char of this.clean(raw)) {
        const unit = this.unit(font, char);
        if (row && ((rowUnits + unit) * CODE) / 1000 > width) {
          rows.push(row);
          row = "";
          rowUnits = 0;
        }
        row += char;
        rowUnits += unit;
      }
      rows.push(row);
      for (const text of rows) {
        this.tick();
        this.space(leading);
        this.page.drawRectangle({ x: MARGIN + context.indent, y: this.y - leading, width: WIDTH - MARGIN * 2 - context.indent, height: leading, color: WASH });
        this.bars(context, this.y, leading);
        if (text.trim()) this.page.drawText(text, { x: MARGIN + context.indent + 6, y: this.y - CODE - (leading - CODE) / 2 + 1, size: CODE, font, color: INK });
        this.y -= leading;
      }
    }
    this.gap(8);
  }

  private rule(context: Context) {
    this.space(16);
    this.gap(6);
    this.page.drawLine({ start: { x: MARGIN + context.indent, y: this.y }, end: { x: WIDTH - MARGIN, y: this.y }, thickness: 0.7, color: RULE });
    this.gap(10);
  }

  private checkbox(top: number, leading: number, x: number, checked: boolean) {
    const side = 8;
    const bottom = top - leading / 2 - side / 2 - 0.5;
    this.page.drawRectangle({ x, y: bottom, width: side, height: side, borderColor: MUTED, borderWidth: 0.8, color: rgb(1, 1, 1) });
    if (!checked) return;
    this.page.drawLine({ start: { x: x + 1.6, y: bottom + 4 }, end: { x: x + 3.4, y: bottom + 2 }, thickness: 1.1, color: INK });
    this.page.drawLine({ start: { x: x + 3.4, y: bottom + 2 }, end: { x: x + 6.6, y: bottom + 6 }, thickness: 1.1, color: INK });
  }

  private list(node: SyntaxNode, context: Context, ordered: boolean) {
    const marked = context.indent > 0;
    const indent = Math.min(context.indent + 18, MAX_INDENT);
    const inner = { ...context, indent };
    this.gap(marked ? 1 : 3);
    let count = 0;
    for (let item = node.firstChild; item; item = item.nextSibling) {
      if (item.name !== "ListItem") continue;
      count += 1;
      const mark = item.getChild("ListMark");
      const label = ordered ? (mark ? this.text.slice(mark.from, mark.to) : `${count}.`) : "•";
      let first = true;
      for (let part = item.firstChild; part; part = part.nextSibling) {
        const name = part.name;
        if (name === "ListMark") continue;
        const marker = first
          ? (top: number, leading: number) => {
              const task = part.name === "Task" ? part.getChild("TaskMarker") : null;
              if (task) {
                this.checkbox(top, leading, MARGIN + indent - 15, /\[[xX]\]/.test(this.text.slice(task.from, task.to)));
                return;
              }
              const safe = this.clean(label);
              const font = this.fonts.regular;
              const left = ordered ? MARGIN + indent - 4 - this.measure(font, safe, BODY) : MARGIN + indent - 12;
              this.page.drawText(safe, { x: left, y: top - BODY - (leading - BODY) / 2 + 1, size: BODY, font, color: ordered ? MUTED : INK });
            }
          : undefined;
        if (name === "Paragraph" || name === "Task") {
          const runs: Run[] = [];
          const start = name === "Task" ? (part.getChild("TaskMarker")?.to ?? part.from) : part.from;
          inlineRuns(this.text, part, start, part.to, NO_STYLE, runs);
          const drawn = this.paragraph(runs, inner, { after: 1.5, marker });
          if (!drawn && marker) {
            this.space(BODY * 1.5);
            marker(this.y, BODY * 1.5);
            this.y -= BODY * 1.5;
          }
          if (drawn || marker) first = false;
        } else {
          if (first && marker) {
            this.space(BODY * 1.5);
            marker(this.y, BODY * 1.5);
            this.y -= BODY * 1.5;
            first = false;
          }
          this.block(part, inner);
        }
      }
    }
    this.gap(marked ? 1 : 4);
  }

  private columns(rows: Run[][][], width: number, pad: number) {
    const count = rows[0].length;
    const natural = new Array<number>(count).fill(0);
    const least = new Array<number>(count).fill(0);
    for (const row of rows) {
      row.forEach((cell, column) => {
        for (const line of this.layout(cell, CELL, Number.MAX_SAFE_INTEGER)) {
          natural[column] = Math.max(natural[column], this.lineWidth(line, CELL));
          for (const word of line) if (word.text.trim()) least[column] = Math.max(least[column], this.width(word, CELL));
        }
      });
    }
    const share = width / count;
    const smallest = least.map((value) => Math.min(Math.max(value, 14) + pad * 2 + 1, share));
    const wanted = natural.map((value, column) => Math.max(Math.max(value, 14) + pad * 2, smallest[column]));
    const sumWanted = wanted.reduce((sum, value) => sum + value, 0);
    if (sumWanted <= width) return wanted.map((value) => value + ((width - sumWanted) * value) / sumWanted);
    const sumSmallest = smallest.reduce((sum, value) => sum + value, 0);
    const spare = width - sumSmallest;
    const excess = wanted.map((value, column) => value - smallest[column]);
    const sumExcess = excess.reduce((sum, value) => sum + value, 0);
    return smallest.map((value, column) => value + (spare * excess[column]) / sumExcess);
  }

  private prepareTable(node: SyntaxNode, context: Context): Prepared | null {
    const key = `${node.from}:${context.indent}`;
    const known = this.tables.get(key);
    if (known) return known;
    const rows: Run[][][] = [];
    let alignments: Align[] = [];
    const cells = (row: SyntaxNode) => row.getChildren("TableCell").map((cell) => runsOf(this.text, cell));
    const header = node.getChild("TableHeader");
    if (!header) return null;
    rows.push(cells(header));
    const delimiter = node.getChildren("TableDelimiter")[0];
    if (delimiter) {
      alignments = this.text
        .slice(delimiter.from, delimiter.to)
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (part.startsWith(":") && part.endsWith(":") ? "center" : part.endsWith(":") ? "right" : "left"));
    }
    for (const row of node.getChildren("TableRow")) rows.push(cells(row));
    const count = rows[0].length;
    if (count === 0) return null;
    const body = rows.map((row, index) =>
      Array.from({ length: count }, (_, column) => (index === 0 ? (row[column] ?? []).map((run) => ({ ...run, bold: true })) : (row[column] ?? []))),
    );
    const width = WIDTH - MARGIN * 2 - context.indent;
    const pad = Math.min(CELL_PAD, Math.max(0.5, width / count / 6));
    const widths = this.columns(body, width, pad);
    const leading = CELL * 1.45;
    const laid = body.map((row) => row.map((cell, column) => this.layout(cell, CELL, Math.max(widths[column] - pad * 2, 1))));
    const headLines = Math.max(...laid[0].map((cell) => cell.length));
    const headHeight = headLines * leading + CELL_VERTICAL * 2;
    const repeat = headHeight + leading * 2 + CELL_VERTICAL * 2 <= PAGE_ROOM;
    const firstRow = laid[1] ? Math.min(Math.max(...laid[1].map((cell) => cell.length), 1), 2) : 0;
    const lead = Math.min(headHeight, PAGE_ROOM) + (firstRow ? firstRow * leading + CELL_VERTICAL * 2 : 0);
    const prepared = { laid, widths, pad, leading, headLines, headHeight, repeat, alignments, left: MARGIN + context.indent, width, lead };
    this.tables.set(key, prepared);
    return prepared;
  }

  private table(node: SyntaxNode, context: Context) {
    const p = this.prepareTable(node, context);
    if (!p) return;
    const { laid, widths, pad, leading, headLines, repeat, left, width } = p;
    const align = (column: number) => p.alignments[column] ?? "left";

    const drawChunk = (cellsOfRow: Word[][][], start: number, lines: number, head: boolean) => {
      const height = lines * leading + CELL_VERTICAL * 2;
      const top = this.y;
      if (head) this.page.drawRectangle({ x: left, y: top - height, width, height, color: WASH });
      let x = left;
      cellsOfRow.forEach((cell, column) => {
        for (let index = 0; index < lines; index += 1) {
          const line = cell[start + index];
          if (line) this.drawLine(line, x + pad, top - CELL_VERTICAL - index * leading, CELL, leading, head ? MUTED : INK, align(column), widths[column] - pad * 2);
        }
        x += widths[column];
      });
      this.page.drawLine({ start: { x: left, y: top - height }, end: { x: left + width, y: top - height }, thickness: 0.6, color: RULE });
      this.y -= height;
    };

    const renderRow = (row: Word[][][], head: boolean) => {
      const again = repeat && !head;
      const total = Math.max(...row.map((cell) => cell.length), 1);
      const capacity = Math.floor((PAGE_ROOM - CELL_VERTICAL * 2 - (again ? p.headHeight : 0)) / leading);
      let start = 0;
      let moved = false;
      let fresh = false;
      const turn = () => {
        this.addPage();
        fresh = true;
        if (again) drawChunk(laid[0], 0, headLines, true);
      };
      while (start < total) {
        let fits = Math.floor((this.y - BOTTOM - CELL_VERTICAL * 2) / leading);
        if (fresh) fits = Math.max(fits, 1);
        const remaining = total - start;
        if (fits >= remaining) {
          drawChunk(row, start, remaining, head);
          start = total;
          fresh = false;
        } else if (start === 0 && !moved && remaining <= capacity) {
          turn();
          moved = true;
        } else if (fits < 1) {
          turn();
        } else {
          drawChunk(row, start, fits, head);
          start += fits;
          fresh = false;
          turn();
        }
      }
    };

    this.gap(4);
    this.space(p.lead);
    renderRow(laid[0], true);
    for (const row of laid.slice(1)) renderRow(row, false);
    this.gap(10);
  }

  private block(node: SyntaxNode, context: Context) {
    this.depth += 1;
    try {
      this.blockAt(node, context);
    } finally {
      this.depth -= 1;
    }
  }

  private blockAt(node: SyntaxNode, context: Context) {
    const name = node.name;
    const nested = name === "Blockquote" || name === "BulletList" || name === "OrderedList";
    if (nested && this.depth > MAX_DEPTH) {
      this.paragraph([plain(displayText(this.text.slice(node.from, node.to).replace(/^[\s>]+/gm, "")))], context, { after: 6 });
      return;
    }
    const level = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (level) return this.heading(node, Number(level[1]), context);
    if (name === "Paragraph") {
      this.paragraph(runsOf(this.text, node), context, { after: 6 });
    } else if (name === "BulletList" || name === "OrderedList") {
      this.list(node, context, name === "OrderedList");
    } else if (name === "Blockquote") {
      const indent = Math.min(context.indent + 14, MAX_INDENT);
      const inner = { indent, bars: indent > context.indent ? [...context.bars, MARGIN + context.indent + 3] : context.bars };
      for (let child = node.firstChild; child; child = child.nextSibling) this.block(child, inner);
    } else if (name === "FencedCode" || name === "CodeBlock") {
      this.code(node, context);
    } else if (name === "HorizontalRule") {
      this.rule(context);
    } else if (name === "Table") {
      this.table(node, context);
    } else if (name === "HTMLBlock") {
      this.paragraph([plain(displayText(this.text.slice(node.from, node.to).replace(HTML_TAG, "")).replace(/\n[ \t]*/g, "\n").trim())], context, { after: 6 });
    }
  }

  render(input: DocPdfInput) {
    const title = input.title.trim() || "Untitled";
    const context: Context = { indent: 0, bars: [] };
    this.paragraph([plain(updatedLabel(input.updatedAt))], context, { size: 8.5, after: 4 });
    this.paragraph([plain(title, { bold: true })], context, { size: 21, after: 10 });
    definitions = new Set([...this.text.matchAll(DEFINITION)].map((match) => referenceKey(match[1])));
    const tree = docsParser.parse(this.text);
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) this.block(child, context);
    const pages = this.pdf.getPages();
    const regular = this.fonts.regular;
    const flat = this.clean(title).replace(/\s+/g, " ");
    const room = WIDTH - MARGIN * 2 - this.measure(regular, ` · Page ${pages.length} of ${pages.length}`, 8);
    let head = flat;
    while (head.length > 1 && this.measure(regular, head, 8) > room) head = `${head.slice(0, -2).trimEnd()}…`;
    pages.forEach((page, index) => {
      page.drawText(`${head} · Page ${index + 1} of ${pages.length}`, { x: MARGIN, y: 30, size: 8, font: regular, color: MUTED });
    });
  }
}

export async function renderDocPdf(input: DocPdfInput, options: { deadline?: number } = {}) {
  const deadline = options.deadline ?? Date.now() + DEADLINE_MS;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const files = await loadFonts();
  const fonts: Fonts = {
    regular: await pdf.embedFont(files.regular, { subset: true }),
    bold: await pdf.embedFont(files.bold, { subset: true }),
    italic: await pdf.embedFont(files.italic, { subset: true }),
  };
  const writer = new DocPdfWriter(pdf, fonts, input.content, deadline);
  const title = input.title.trim() || "Untitled";
  pdf.setTitle(writer.clean(title));
  pdf.setCreator("Orbit");
  pdf.setProducer("Orbit");
  pdf.setCreationDate(new Date(input.updatedAt));
  pdf.setModificationDate(new Date(input.updatedAt));
  writer.render(input);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
