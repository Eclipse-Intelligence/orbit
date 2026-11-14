import type { DocPick } from "@/lib/docs/client-types";

export function privateDocWarning(doc: Pick<DocPick, "folderPath">) {
  const folder = doc.folderPath?.split(" › ").pop() ?? "Top level";
  return `${folder}, private. Teammates will see "Doc" only`;
}

export function docPickHeading(query: string, docs: DocPick[] | null) {
  if (!docs) return "";
  if (!query.trim()) return docs.length > 0 ? "Recent" : "";
  return docs.length === 1 ? "1 match" : `${docs.length} matches`;
}

export function docPickNotice(query: string, docs: DocPick[] | null, failed: boolean) {
  if (failed) return "Couldn't search. Try again.";
  if (docs && docs.length === 0 && query.trim()) return "No docs match";
  return null;
}

export const WEB_ADDRESS = /\bhttps?:\/\//i;

export function showsDescriptionLinks(text: string, layout: "panel" | "row", editing: boolean) {
  return layout === "panel" && !editing && WEB_ADDRESS.test(text);
}

const BIDI = /[‎‏‪-‮⁦-⁩]/;

export function sourceOffset(text: string, shown: number) {
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (BIDI.test(text[index])) continue;
    if (seen === shown) return index;
    seen += 1;
  }
  return text.length;
}
