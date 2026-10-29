import { CrmError } from "@/lib/crm/errors";
import { findTags, maskCode, normaliseTag } from "@/lib/docs/markdown";
import type { DocEdit } from "@/lib/docs/types";

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

function lastLine(text: string) {
  const lines = text.split("\n");
  return lines[lines.length - 1] ?? "";
}

export function appendText(content: string, text: string) {
  const body = content.replace(/\s+$/, "");
  const addition = text.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!addition) return content;
  if (!body) return addition;
  const joiner = LIST_ITEM.test(lastLine(body)) && LIST_ITEM.test(addition.split("\n")[0]) ? "\n" : "\n\n";
  return `${body}${joiner}${addition}`;
}

function occurrences(content: string, find: string) {
  const found: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(find, from);
    if (index < 0) break;
    found.push(index);
    from = index + find.length;
  }
  return found;
}

export function findAndReplace(content: string, find: string, replace: string, all = false) {
  if (!find) throw new CrmError("invalid_input", "Say which text to change.", 400, { field: "find" });
  const found = occurrences(content, find);
  if (found.length === 0) {
    throw new CrmError("invalid_input", "That text isn't in the doc. Read the doc again and copy the exact words to change.", 400, { field: "find" });
  }
  if (found.length > 1 && !all) {
    throw new CrmError(
      "invalid_input",
      `That text appears ${found.length} times. Include more of the words around it so it matches once, or set all to change every one.`,
      400,
      { field: "find" },
    );
  }
  return all ? content.split(find).join(replace) : `${content.slice(0, found[0])}${replace}${content.slice(found[0] + find.length)}`;
}

function cleanTags(values: string[] | undefined) {
  const tags: string[] = [];
  for (const value of values ?? []) {
    const tag = normaliseTag(value);
    if (!tag) throw new CrmError("invalid_input", `"${value}" isn't a tag Orbit can use. Use letters, numbers, - and _, with / for nesting, like clients/acme.`, 400, { field: "tags" });
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function retag(content: string, add: string[] | undefined, remove: string[] | undefined) {
  const adding = cleanTags(add);
  const removing = new Set(cleanTags(remove));
  let output = content;
  if (removing.size > 0) {
    const matches = findTags(output, maskCode(output)).filter((match) => removing.has(match.tag));
    for (const match of [...matches].reverse()) {
      let from = match.start;
      let to = match.end;
      if (from === 0 || output[from - 1] === "\n") {
        while (output[to] === " " || output[to] === "\t") to += 1;
      } else {
        while (from > 0 && (output[from - 1] === " " || output[from - 1] === "\t")) from -= 1;
      }
      output = output.slice(0, from) + output.slice(to);
    }
    output = output.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n").replace(/\s+$/, "");
  }
  const present = new Set(findTags(output).map((match) => match.tag));
  const missing = adding.filter((tag) => !present.has(tag));
  if (missing.length === 0) return output;
  const tagLine = missing.map((tag) => `#${tag}`).join(" ");
  const body = output.replace(/\s+$/, "");
  const last = lastLine(body);
  const onlyTags = last.trim() !== "" && last.trim().split(/\s+/).every((word) => word.startsWith("#") && normaliseTag(word) !== null);
  if (onlyTags) return `${body} ${tagLine}`;
  return body ? `${body}\n\n${tagLine}` : tagLine;
}

export function applyDocEdit(content: string, edit: DocEdit) {
  if (edit.action === "replace") return edit.content;
  if (edit.action === "append") return appendText(content, edit.content);
  if (edit.action === "edit") return findAndReplace(content, edit.find, edit.replace, edit.all === true);
  return retag(content, edit.add, edit.remove);
}

export function editSummary(edit: DocEdit) {
  if (edit.action === "replace") return "Rewrote the doc";
  if (edit.action === "append") return "Added to the end";
  if (edit.action === "edit") return `Changed "${edit.find.replace(/\s+/g, " ").slice(0, 60)}"`;
  const parts = [
    ...(edit.add?.length ? [`added ${edit.add.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`] : []),
    ...(edit.remove?.length ? [`removed ${edit.remove.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`] : []),
  ];
  const text = parts.join(", ") || "Tags";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
