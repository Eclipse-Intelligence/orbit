import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  BILLING_LABELS,
  BILLINGS,
  formatMoney,
  longDate,
  parseBody,
  type Content,
  type Inline,
} from "@/lib/proposals/model";

export type PdfSignature = {
  role: "client" | "sender";
  name: string;
  title: string | null;
  company: string | null;
  signatureText: string;
  signatureImage: string | null;
  signedAt: string;
  ip: string | null;
  method: string;
  email: string;
};

export type PdfEvent = { type: string; at: string; who: string | null; ip: string | null };

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };

const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 56;
const INK = rgb(0.11, 0.11, 0.13);
const MUTED = rgb(0.42, 0.43, 0.47);
const RULE = rgb(0.88, 0.88, 0.9);

const REPLACEMENTS: Record<string, string> = { "→": "->", "←": "<-", "✓": "v", " ": " ", " ": " " };
const ALLOWED = /[\x20-\x7e\xa1-\xff€‘’“”•…\u2013\u2014£]/;

function clean(value: string) {
  return [...value.replace(/\t/g, "  ")]
    .map((char) => REPLACEMENTS[char] ?? (ALLOWED.test(char) ? char : char === "\n" ? char : "?"))
    .join("");
}

function hexColour(value: string): RGB {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) return rgb(0.25, 0.14, 0.98);
  return rgb(parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255);
}

class Writer {
  page: PDFPage;
  y = HEIGHT - MARGIN;

  constructor(
    private pdf: PDFDocument,
    private fonts: Fonts,
    private footer: string,
  ) {
    this.page = this.newPage();
  }

  newPage() {
    const page = this.pdf.addPage([WIDTH, HEIGHT]);
    page.drawText(clean(this.footer), { x: MARGIN, y: 28, size: 8, font: this.fonts.regular, color: MUTED });
    this.page = page;
    this.y = HEIGHT - MARGIN;
    return page;
  }

  space(height: number) {
    if (this.y - height < MARGIN + 20) this.newPage();
  }

  gap(height: number) {
    this.y -= height;
  }

  lines(parts: Inline[], options: { size: number; font?: PDFFont; color?: RGB; indent?: number; leading?: number; width?: number }) {
    const size = options.size;
    const leading = options.leading ?? size * 1.45;
    const maxWidth = options.width ?? WIDTH - MARGIN * 2 - (options.indent ?? 0);
    type Word = { text: string; font: PDFFont; color: RGB };
    const words: (Word | "\n")[] = [];
    for (const part of parts) {
      const font = part.bold ? this.fonts.bold : (options.font ?? this.fonts.regular);
      const color = part.href ? rgb(0.15, 0.3, 0.75) : (options.color ?? INK);
      const value = clean(part.href ? `${part.text} (${part.href})` : part.text);
      const segments = value.split("\n");
      segments.forEach((segment, index) => {
        if (index > 0) words.push("\n");
        for (const word of segment.split(/(\s+)/)) if (word) words.push({ text: word, font, color });
      });
    }
    let line: Word[] = [];
    let width = 0;
    const flush = () => {
      this.space(leading);
      let x = MARGIN + (options.indent ?? 0);
      const runs: Word[] = [];
      for (const word of line) {
        const last = runs.at(-1);
        if (last && last.font === word.font && last.color === word.color) last.text += word.text;
        else runs.push({ ...word });
      }
      for (const run of runs) {
        const text = run.text.replace(/\s+$/, "");
        if (text) this.page.drawText(text, { x, y: this.y - size, size, font: run.font, color: run.color });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      this.y -= leading;
      line = [];
      width = 0;
    };
    for (const word of words) {
      if (word === "\n") {
        flush();
        continue;
      }
      const wordWidth = word.font.widthOfTextAtSize(word.text, size);
      if (width + wordWidth > maxWidth && line.length && word.text.trim()) {
        flush();
        if (!word.text.trim()) continue;
      }
      if (!line.length && !word.text.trim()) continue;
      line.push(word);
      width += wordWidth;
    }
    if (line.length) flush();
  }

  rule(colour: RGB = RULE) {
    this.space(12);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: WIDTH - MARGIN, y: this.y }, thickness: 0.6, color: colour });
    this.y -= 12;
  }
}

function body(writer: Writer, fonts: Fonts, value: string) {
  for (const paragraph of parseBody(value)) {
    if (paragraph.kind === "subheading") {
      writer.gap(4);
      writer.lines(paragraph.parts, { size: 11.5, font: fonts.bold });
    } else if (paragraph.kind === "bullet") {
      writer.space(16);
      writer.page.drawText("•", { x: MARGIN + 4, y: writer.y - 10.5, size: 10.5, font: fonts.regular, color: INK });
      writer.lines(paragraph.parts, { size: 10.5, indent: 16 });
    } else {
      writer.lines(paragraph.parts, { size: 10.5 });
      writer.gap(5);
    }
  }
}

function pricing(writer: Writer, fonts: Fonts, content: Content) {
  const right = WIDTH - MARGIN;
  writer.space(24);
  writer.page.drawText("Item", { x: MARGIN, y: writer.y - 9, size: 8.5, font: fonts.bold, color: MUTED });
  for (const [label, x] of [
    ["Billing", right - 230],
    ["Qty", right - 140],
    ["Amount", right - 70],
  ] as const) {
    writer.page.drawText(label, { x, y: writer.y - 9, size: 8.5, font: fonts.bold, color: MUTED });
  }
  writer.gap(16);
  writer.rule();
  for (const item of content.items) {
    writer.space(30);
    const top = writer.y;
    const amount = formatMoney(item.unitPrice * item.quantity, content.currency);
    writer.page.drawText(BILLING_LABELS[item.billing], { x: right - 230, y: top - 10.5, size: 10, font: fonts.regular, color: INK });
    writer.page.drawText(String(item.quantity), { x: right - 140, y: top - 10.5, size: 10, font: fonts.regular, color: INK });
    writer.page.drawText(clean(amount), { x: right - 70, y: top - 10.5, size: 10, font: fonts.regular, color: INK });
    const saved = writer.y;
    writer.y = top;
    const column = right - 230 - MARGIN - 14;
    writer.lines([{ text: item.name, bold: true }], { size: 10.5, width: column });
    if (item.description) writer.lines([{ text: item.description }], { size: 9.5, color: MUTED, width: column });
    writer.y = Math.min(writer.y, saved);
    writer.gap(4);
    writer.rule();
  }
  for (const billing of BILLINGS) {
    const total = content.totals[billing];
    if (!total) continue;
    writer.space(18);
    const label = billing === "one_off" ? "Total one-off" : billing === "monthly" ? "Total a month" : "Total a year";
    writer.page.drawText(label, { x: right - 230, y: writer.y - 11, size: 10.5, font: fonts.bold, color: INK });
    writer.page.drawText(clean(formatMoney(total, content.currency)), { x: right - 70, y: writer.y - 11, size: 10.5, font: fonts.bold, color: INK });
    writer.gap(18);
  }
}

async function signatures(pdf: PDFDocument, writer: Writer, fonts: Fonts, content: Content, signed: PdfSignature[]) {
  writer.space(230);
  writer.gap(10);
  writer.lines([{ text: "Signatures" }], { size: 15, font: fonts.bold });
  writer.gap(4);
  writer.lines([{ text: content.consent }], { size: 9, color: MUTED });
  writer.gap(8);
  for (const role of ["client", "sender"] as const) {
    const party = role === "client" ? content.client : content.sender;
    const signature = signed.find((item) => item.role === role);
    writer.space(110);
    writer.lines([{ text: `For ${party.company}`, bold: true }], { size: 10 });
    if (signature?.signatureImage?.startsWith("data:image/png;base64,")) {
      try {
        const image = await pdf.embedPng(Buffer.from(signature.signatureImage.slice(22), "base64"));
        const scaled = image.scaleToFit(180, 50);
        writer.space(56);
        writer.page.drawImage(image, { x: MARGIN, y: writer.y - scaled.height, width: scaled.width, height: scaled.height });
        writer.gap(scaled.height + 4);
      } catch {}
    } else if (signature) {
      writer.lines([{ text: signature.signatureText }], { size: 20, font: fonts.italic });
    } else {
      writer.gap(26);
    }
    writer.page.drawLine({ start: { x: MARGIN, y: writer.y }, end: { x: MARGIN + 240, y: writer.y }, thickness: 0.6, color: MUTED });
    writer.gap(6);
    const name = signature?.name ?? party.name;
    const title = signature?.title ?? party.title;
    writer.lines([{ text: `${name}${title ? `, ${title}` : ""}` }], { size: 9.5 });
    writer.lines([{ text: signature ? `Signed ${longDate(signature.signedAt)} at ${new Date(signature.signedAt).toISOString().slice(11, 16)} UTC` : "Not signed yet" }], {
      size: 9,
      color: MUTED,
    });
    writer.gap(12);
  }
}

export async function renderPdf(input: {
  content: Content;
  contentHash: string;
  documentId: string;
  versionNumber: number;
  signatures?: PdfSignature[];
  events?: PdfEvent[];
}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(clean(input.content.title));
  pdf.setAuthor(clean(input.content.sender.company));
  pdf.setCreator("Orbit");
  pdf.setCreationDate(new Date(input.content.issuedAt));
  pdf.setModificationDate(new Date(input.content.issuedAt));
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const accent = hexColour(input.content.accent);
  const writer = new Writer(pdf, fonts, `${input.content.title} · ${input.content.sender.company} · Reference ${input.documentId.slice(0, 8)} v${input.versionNumber}`);
  writer.page.drawRectangle({ x: 0, y: HEIGHT - 8, width: WIDTH, height: 8, color: accent });
  for (const block of input.content.blocks) {
    if (block.type === "cover") {
      writer.gap(30);
      writer.lines([{ text: block.title || input.content.title }], { size: 26, font: fonts.bold, leading: 32 });
      if (block.subtitle) {
        writer.gap(4);
        writer.lines([{ text: block.subtitle }], { size: 12, color: MUTED });
      }
      writer.gap(6);
      const meta = [
        `Issued ${longDate(input.content.issuedAt)}`,
        input.content.validUntil ? `Valid until ${longDate(input.content.validUntil)}` : "",
      ].filter(Boolean);
      writer.lines([{ text: meta.join("   ") }], { size: 9.5, color: MUTED });
      writer.gap(18);
      writer.rule(accent);
      continue;
    }
    writer.space(40);
    writer.gap(8);
    if ("heading" in block && block.heading) writer.lines([{ text: block.heading }], { size: 15, font: fonts.bold, leading: 20 });
    writer.gap(4);
    if (block.type === "section") body(writer, fonts, block.body);
    if (block.type === "pricing") {
      if (block.intro) body(writer, fonts, block.intro);
      pricing(writer, fonts, input.content);
    }
    if (block.type === "terms") {
      body(writer, fonts, block.body);
      if (block.linkUrl) writer.lines([{ text: block.linkLabel || block.linkUrl, href: block.linkUrl }], { size: 10.5 });
    }
  }
  await signatures(pdf, writer, fonts, input.content, input.signatures ?? []);
  if (input.events?.length) {
    writer.newPage();
    writer.lines([{ text: "Signing certificate" }], { size: 18, font: fonts.bold, leading: 24 });
    writer.gap(4);
    writer.lines([{ text: `${input.content.title}, reference ${input.documentId}, version ${input.versionNumber}` }], { size: 9.5, color: MUTED });
    writer.lines([{ text: `Content fingerprint (SHA-256): ${input.contentHash}` }], { size: 8.5, color: MUTED });
    writer.gap(10);
    for (const signature of input.signatures ?? []) {
      writer.lines([{ text: `${signature.role === "client" ? "Client" : "Sender"}: ${signature.name}`, bold: true }], { size: 10 });
      writer.lines(
        [
          {
            text: `${signature.email}${signature.title ? `, ${signature.title}` : ""}${signature.company ? `, ${signature.company}` : ""}. Typed signature "${signature.signatureText}". Signed ${new Date(signature.signedAt).toISOString().replace("T", " ").slice(0, 19)} UTC by ${signature.method === "orbit_login" ? "signing in to Orbit" : "the link sent to their email address"}${signature.ip ? ` from IP ${signature.ip}` : ""}.`,
          },
        ],
        { size: 9, color: MUTED },
      );
      writer.gap(6);
    }
    writer.gap(6);
    writer.lines([{ text: "Events (UTC)", bold: true }], { size: 10 });
    for (const event of input.events) {
      writer.lines([{ text: `${event.at.replace("T", " ").slice(0, 19)}  ${event.type}${event.who ? `  ${event.who}` : ""}${event.ip ? `  ${event.ip}` : ""}` }], {
        size: 8.5,
        color: INK,
      });
    }
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
