import fontkit from "@pdf-lib/fontkit";
import type { SyntaxNode } from "@lezer/common";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { docsParser } from "@/lib/docs/editor/syntax";
import { updatedLabel } from "@/lib/docs/public-link";
import { loadFonts } from "@/lib/proposals/pdf";

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };
type Run = { text: string; bold: boolean; italic: boolean; code: boolean };
type Word = { text: string; font: PDFFont; code: boolean };
type Align = "left" | "center" | "right";
type Context = { indent: number; bars: number[] };

const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 56;
const BOTTOM = 64;
const BODY = 10.5;
const CODE = 9;
const CELL = 9;
const CELL_PAD = 5;
const CELL_VERTICAL = 4;
const INK = rgb(0.11, 0.11, 0.13);
const MUTED = rgb(0.42, 0.43, 0.47);
const RULE = rgb(0.86, 0.86, 0.89);
const WASH = rgb(0.955, 0.957, 0.965);
const MENTION_PATTERN = /^@\[([^[\]\n]{1,200})\]\(/;
const MARK = /Mark$/;
const MARK_KEPT = new Set(["Hashtag"]);

export type DocPdfInput = { title: string; content: string; updatedAt: string | Date };

function plain(run: Partial<Run> & { text: string }): Run {
  return { bold: false, italic: false, code: false, ...run };
}

function inlineRuns(text: string, node: SyntaxNode, from: number, to: number, base: Omit<Run, "text">, out: Run[]) {
  const push = (value: string, style: Omit<Run, "text"> = base) => {
    if (value) out.push({ ...style, text: value });
  };
  let at = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue;
    if (child.from >= to) break;
    if (child.from > at) push(text.slice(at, child.from).replace(/\n[ \t]*/g, "\n"));
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
    } else if (name === "InlineCode") {
      const marks = child.getChildren("CodeMark");
      const inner = marks.length >= 2 ? text.slice(marks[0].to, marks[marks.length - 1].from) : text.slice(child.from, child.to);
      push(inner.replace(/\s+/g, " "), { ...base, code: true });
    } else if (name === "Link" || name === "Image") {
      const marks = child.getChildren("LinkMark");
      if (marks.length >= 2) inlineRuns(text, child, marks[0].to, marks[1].from, base, out);
      else push(text.slice(child.from, child.to));
    } else if (name === "WikiLink") {
      const inner = text.slice(child.from + 2, child.to - 2);
      const bar = inner.indexOf("|");
      push(bar >= 0 ? inner.slice(bar + 1) : inner);
    } else if (name === "Mention") {
      push(MENTION_PATTERN.exec(text.slice(child.from, child.to))?.[1] ?? "");
    } else if (child.firstChild && name !== "Hashtag" && name !== "URL") {
      inlineRuns(text, child, child.from, child.to, base, out);
    } else {
      push(text.slice(child.from, child.to));
    }
  }
  if (at < to) push(text.slice(at, to).replace(/\n[ \t]*/g, "\n"));
}

function runsOf(text: string, node: SyntaxNode, bold = false) {
  const out: Run[] = [];
  inlineRuns(text, node, node.from, node.to, { bold, italic: false, code: false }, out);
  return out;
}

export class DocPdfWriter {
  private page: PDFPage;
  private y = HEIGHT - MARGIN;
  private known: Set<number>;

  constructor(
    private pdf: PDFDocument,
    private fonts: Fonts,
    private text: string,
  ) {
    this.known = new Set(fonts.regular.getCharacterSet());
    this.page = this.addPage();
  }

  private addPage() {
    this.page = this.pdf.addPage([WIDTH, HEIGHT]);
    this.y = HEIGHT - MARGIN;
    return this.page;
  }

  clean(value: string) {
    return [...value.normalize("NFC").replace(/\t/g, "  ").replace(/[  ]/g, " ")]
      .map((char) => {
        if (char === "\n") return char;
        const point = char.codePointAt(0) ?? 0;
        if (point < 0x20) return " ";
        return this.known.has(point) ? char : "?";
      })
      .join("");
  }

  private space(height: number) {
    if (this.y - height < BOTTOM) this.addPage();
  }

  private gap(height: number) {
    this.y -= height;
  }

  private fontFor(run: Run) {
    return run.bold ? this.fonts.bold : run.italic ? this.fonts.italic : this.fonts.regular;
  }

  private width(word: Word, size: number) {
    return word.font.widthOfTextAtSize(word.text, size);
  }

  layout(runs: Run[], size: number, width: number): Word[][] {
    const words: (Word | "\n")[] = [];
    for (const run of runs) {
      const font = this.fontFor(run);
      const lines = this.clean(run.text).split("\n");
      lines.forEach((line, index) => {
        if (index > 0) words.push("\n");
        for (const piece of line.split(/(\s+)/)) {
          if (!piece) continue;
          if (font.widthOfTextAtSize(piece, size) <= width) {
            words.push({ text: piece, font, code: run.code });
            continue;
          }
          let part = "";
          for (const char of piece) {
            if (part && font.widthOfTextAtSize(part + char, size) > width) {
              words.push({ text: part, font, code: run.code });
              words.push({ text: " ", font, code: run.code });
              part = "";
            }
            part += char;
          }
          if (part) words.push({ text: part, font, code: run.code });
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
    const offset = align === "right" ? width - this.lineWidth(line, size) : align === "center" ? (width - this.lineWidth(line, size)) / 2 : 0;
    let at = x + Math.max(0, offset);
    for (const word of line) {
      const wide = this.width(word, size);
      if (word.code && word.text.trim()) {
        this.page.drawRectangle({ x: at - 1, y: top - leading + 2, width: wide + 2, height: leading - 3, color: WASH });
      }
      if (word.text.trim()) this.page.drawText(word.text, { x: at, y: top - size - (leading - size) / 2 + 1, size, font: word.font, color });
      at += wide;
    }
  }

  private bars(context: Context, top: number, height: number) {
    for (const x of context.bars) {
      this.page.drawLine({ start: { x, y: top }, end: { x, y: top - height }, thickness: 2, color: RULE });
    }
  }

  private paragraph(runs: Run[], context: Context, options: { size?: number; before?: number; after?: number; keep?: number; marker?: (top: number, leading: number) => void } = {}) {
    const size = options.size ?? BODY;
    const leading = size * 1.5;
    const lines = this.layout(runs, size, WIDTH - MARGIN * 2 - context.indent);
    if (lines.every((line) => line.length === 0)) return false;
    this.gap(options.before ?? 0);
    this.space(leading + (options.keep ?? 0));
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
    this.paragraph(runsOf(this.text, node, true), context, { size, before: level <= 2 ? 10 : 6, after: 3, keep: 40 });
  }

  private code(node: SyntaxNode, context: Context) {
    const body = node.getChild("CodeText");
    const source = body ? this.text.slice(body.from, body.to) : "";
    const width = WIDTH - MARGIN * 2 - context.indent - 12;
    const leading = CODE * 1.5;
    const font = this.fonts.regular;
    this.gap(4);
    for (const raw of source.replace(/\s+$/, "").split("\n")) {
      const full = this.clean(raw);
      const rows: string[] = [];
      let row = "";
      for (const char of full) {
        if (row && font.widthOfTextAtSize(row + char, CODE) > width) {
          rows.push(row);
          row = "";
        }
        row += char;
      }
      rows.push(row);
      for (const text of rows) {
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
    const indent = context.indent + 18;
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
        const lead = first;
        const marker = lead
          ? (top: number, leading: number) => {
              const task = part.name === "Task" ? part.getChild("TaskMarker") : null;
              if (task) {
                this.checkbox(top, leading, MARGIN + indent - 15, /\[[xX]\]/.test(this.text.slice(task.from, task.to)));
                return;
              }
              const safe = this.clean(label);
              const font = this.fonts.regular;
              const left = ordered ? MARGIN + indent - 4 - font.widthOfTextAtSize(safe, BODY) : MARGIN + indent - 12;
              this.page.drawText(safe, { x: left, y: top - BODY - (leading - BODY) / 2 + 1, size: BODY, font, color: ordered ? MUTED : INK });
            }
          : undefined;
        if (name === "Paragraph" || name === "Task") {
          const runs: Run[] = [];
          const start = name === "Task" ? (part.getChild("TaskMarker")?.to ?? part.from) : part.from;
          inlineRuns(this.text, part, start, part.to, { bold: false, italic: false, code: false }, runs);
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

  private columns(rows: Run[][][], width: number) {
    const count = rows[0].length;
    const natural = new Array<number>(count).fill(0);
    const least = new Array<number>(count).fill(0);
    for (const row of rows) {
      row.forEach((cell, column) => {
        for (const line of this.layout(cell, CELL, 100_000)) {
          natural[column] = Math.max(natural[column], this.lineWidth(line, CELL));
          for (const word of line) if (word.text.trim()) least[column] = Math.max(least[column], this.width(word, CELL));
        }
      });
    }
    const pad = CELL_PAD * 2;
    const wanted = natural.map((value) => Math.max(value, 14) + pad);
    const smallest = least.map((value) => Math.max(value, 14) + pad + 1);
    const sumWanted = wanted.reduce((sum, value) => sum + value, 0);
    if (sumWanted <= width) return wanted.map((value) => value + ((width - sumWanted) * value) / sumWanted);
    const sumSmallest = smallest.reduce((sum, value) => sum + value, 0);
    if (sumSmallest >= width) return smallest.map((value) => (value * width) / sumSmallest);
    const spare = width - sumSmallest;
    const excess = wanted.map((value, column) => value - smallest[column]);
    const sumExcess = excess.reduce((sum, value) => sum + value, 0);
    return smallest.map((value, column) => value + (spare * excess[column]) / sumExcess);
  }

  private table(node: SyntaxNode, context: Context) {
    const rows: Run[][][] = [];
    let alignments: Align[] = [];
    const cells = (row: SyntaxNode) => row.getChildren("TableCell").map((cell) => runsOf(this.text, cell));
    const header = node.getChild("TableHeader");
    if (!header) return;
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
    if (count === 0) return;
    const body = rows.map((row, index) =>
      Array.from({ length: count }, (_, column) => (index === 0 ? (row[column] ?? []).map((run) => ({ ...run, bold: true })) : (row[column] ?? []))),
    );
    const width = WIDTH - MARGIN * 2 - context.indent;
    const widths = this.columns(body, width);
    const leading = CELL * 1.45;
    const laid = body.map((row) => row.map((cell, column) => this.layout(cell, CELL, widths[column] - CELL_PAD * 2)));
    const left = MARGIN + context.indent;
    const headLines = Math.max(...laid[0].map((cell) => cell.length));
    const headHeight = headLines * leading + CELL_VERTICAL * 2;
    const align = (column: number) => alignments[column] ?? "left";

    const drawChunk = (cellsOfRow: Word[][][], start: number, lines: number, head: boolean) => {
      const height = lines * leading + CELL_VERTICAL * 2;
      const top = this.y;
      if (head) this.page.drawRectangle({ x: left, y: top - height, width, height, color: WASH });
      let x = left;
      cellsOfRow.forEach((cell, column) => {
        for (let index = 0; index < lines; index += 1) {
          const line = cell[start + index];
          if (line) this.drawLine(line, x + CELL_PAD, top - CELL_VERTICAL - index * leading, CELL, leading, head ? MUTED : INK, align(column), widths[column] - CELL_PAD * 2);
        }
        x += widths[column];
      });
      this.page.drawLine({ start: { x: left, y: top - height }, end: { x: left + width, y: top - height }, thickness: 0.6, color: RULE });
      this.y -= height;
    };

    const newPage = () => {
      this.addPage();
      drawChunk(laid[0], 0, headLines, true);
    };

    this.gap(4);
    this.space(headHeight + leading * 3 + CELL_VERTICAL * 2);
    drawChunk(laid[0], 0, headLines, true);
    const pageCapacity = Math.floor((HEIGHT - MARGIN - BOTTOM - headHeight - CELL_VERTICAL * 2) / leading);
    for (const row of laid.slice(1)) {
      const total = Math.max(...row.map((cell) => cell.length), 1);
      let start = 0;
      let moved = false;
      while (start < total) {
        const fits = Math.floor((this.y - BOTTOM - CELL_VERTICAL * 2) / leading);
        const remaining = total - start;
        if (fits >= remaining) {
          drawChunk(row, start, remaining, false);
          start = total;
        } else if (start === 0 && !moved && remaining <= pageCapacity) {
          newPage();
          moved = true;
        } else if (fits < 1) {
          newPage();
        } else {
          drawChunk(row, start, fits, false);
          start += fits;
          newPage();
        }
      }
    }
    this.gap(10);
  }

  private block(node: SyntaxNode, context: Context) {
    const name = node.name;
    const level = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (level) return this.heading(node, Number(level[1]), context);
    if (name === "Paragraph") {
      this.paragraph(runsOf(this.text, node), context, { after: 6 });
    } else if (name === "BulletList" || name === "OrderedList") {
      this.list(node, context, name === "OrderedList");
    } else if (name === "Blockquote") {
      const inner = { indent: context.indent + 14, bars: [...context.bars, MARGIN + context.indent + 3] };
      for (let child = node.firstChild; child; child = child.nextSibling) this.block(child, inner);
    } else if (name === "FencedCode" || name === "CodeBlock") {
      this.code(node, context);
    } else if (name === "HorizontalRule") {
      this.rule(context);
    } else if (name === "Table") {
      this.table(node, context);
    } else if (name === "HTMLBlock") {
      this.paragraph([plain({ text: this.text.slice(node.from, node.to) })], context, { after: 6 });
    }
  }

  render(input: DocPdfInput) {
    const title = input.title.trim() || "Untitled";
    const context: Context = { indent: 0, bars: [] };
    this.paragraph([plain({ text: updatedLabel(input.updatedAt) })], context, { size: 8.5, after: 4 });
    this.paragraph([plain({ text: title, bold: true })], context, { size: 21, after: 10 });
    const tree = docsParser.parse(this.text);
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) this.block(child, context);
    const pages = this.pdf.getPages();
    pages.forEach((page, index) => {
      const label = `Page ${index + 1} of ${pages.length}`;
      const labelWidth = this.fonts.regular.widthOfTextAtSize(label, 8);
      let footer = this.clean(title).replace(/\s+/g, " ");
      const room = WIDTH - MARGIN * 2 - labelWidth - 16;
      while (footer.length > 1 && this.fonts.regular.widthOfTextAtSize(footer, 8) > room) footer = `${footer.slice(0, -2).trimEnd()}…`;
      page.drawText(footer, { x: MARGIN, y: 30, size: 8, font: this.fonts.regular, color: MUTED });
      page.drawText(label, { x: WIDTH - MARGIN - labelWidth, y: 30, size: 8, font: this.fonts.regular, color: MUTED });
    });
  }
}

export async function renderDocPdf(input: DocPdfInput) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const files = await loadFonts();
  const fonts: Fonts = {
    regular: await pdf.embedFont(files.regular, { subset: true }),
    bold: await pdf.embedFont(files.bold, { subset: true }),
    italic: await pdf.embedFont(files.italic, { subset: true }),
  };
  const writer = new DocPdfWriter(pdf, fonts, input.content);
  const title = input.title.trim() || "Untitled";
  pdf.setTitle(writer.clean(title));
  pdf.setCreator("Orbit");
  pdf.setProducer("Orbit");
  pdf.setCreationDate(new Date(input.updatedAt));
  pdf.setModificationDate(new Date(input.updatedAt));
  writer.render(input);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
