import { strFromU8, unzipSync } from "fflate";

export const TEXT_MAX = 30_000;

const OFFICE_TYPES: Record<string, "docx" | "xlsx" | "pptx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

const PLAIN = /\.(txt|csv|tsv|md|markdown|json|ics|vcf|log|xml|html?)$/i;

export type AttachmentKind = "pdf" | "docx" | "xlsx" | "pptx" | "text" | "html";

export function attachmentKind(name: string, contentType: string | null): AttachmentKind | null {
  const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
  const lower = name.toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (OFFICE_TYPES[type]) return OFFICE_TYPES[type];
  const extension = lower.match(/\.(docx|xlsx|pptx)$/)?.[1];
  if (extension) return extension as "docx" | "xlsx" | "pptx";
  if (type === "text/html" || /\.html?$/.test(lower)) return "html";
  if (type.startsWith("text/") || type === "application/json" || PLAIN.test(lower)) return "text";
  return null;
}

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \u00a0]+/g, " ")
    .replace(/\t+/g, "\t")
    .replace(/ *\t */g, "\t")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, TEXT_MAX);
}

function htmlText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

function docxText(files: Record<string, Uint8Array>) {
  const document = files["word/document.xml"];
  if (!document) return "";
  return decodeEntities(
    strFromU8(document)
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

function numbered(prefix: string, files: Record<string, Uint8Array>) {
  return Object.keys(files)
    .map((path) => ({ path, number: Number(path.match(new RegExp(`^${prefix}(\\d+)\\.xml$`))?.[1] ?? NaN) }))
    .filter((item) => Number.isFinite(item.number))
    .sort((a, b) => a.number - b.number);
}

function pptxText(files: Record<string, Uint8Array>) {
  return numbered("ppt/slides/slide", files)
    .map(({ path, number }) => {
      const xml = strFromU8(files[path]);
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<\/a:p>/g)].map((match) => (match[1] === undefined ? "\n" : decodeEntities(match[1])));
      return `Slide ${number}:\n${runs.join("")}`;
    })
    .join("\n\n");
}

function xlsxText(files: Record<string, Uint8Array>) {
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
        decodeEntities([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")),
      )
    : [];
  const names = files["xl/workbook.xml"] ? [...strFromU8(files["xl/workbook.xml"]).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((match) => decodeEntities(match[1])) : [];
  return numbered("xl/worksheets/sheet", files)
    .map(({ path, number }, index) => {
      const xml = strFromU8(files[path]);
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((cell) => {
            const type = cell[1].match(/\bt="(\w+)"/)?.[1];
            const body = cell[2] ?? "";
            const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
            const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
            if (type === "s" && value !== undefined) return shared[Number(value)] ?? "";
            return decodeEntities(inline ?? value ?? "");
          })
          .join("\t")
          .replace(/\t+$/, ""),
      );
      return `Sheet ${names[index] ?? number}:\n${rows.filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
}

async function pdfText(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(document, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((page, index) => `Page ${index + 1}:\n${page}`).join("\n\n");
}

export async function readAttachmentText(bytes: Uint8Array, name: string, contentType: string | null): Promise<string | null> {
  const kind = attachmentKind(name, contentType);
  if (!kind) return null;
  let text = "";
  if (kind === "pdf") text = await pdfText(bytes);
  else if (kind === "text") text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  else if (kind === "html") text = htmlText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  else {
    const files = unzipSync(bytes, { filter: (file) => file.name.endsWith(".xml") && file.originalSize < 20_000_000 });
    text = kind === "docx" ? docxText(files) : kind === "pptx" ? pptxText(files) : xlsxText(files);
  }
  const cleaned = tidy(text);
  return cleaned.replace(/(Page|Slide|Sheet) [^\n]*:\n?/g, "").trim() ? cleaned : null;
}
