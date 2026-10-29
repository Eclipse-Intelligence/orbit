import { createHash } from "node:crypto";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { appendDailyEntry, localTime } from "@/lib/docs/daily";
import { appendToDailyNote, getDailyNote } from "@/lib/docs/daily-notes";
import { diffCounts, lineDiff } from "@/lib/docs/diff";
import { applyDocEdit } from "@/lib/docs/edits";
import { getFolder } from "@/lib/docs/folders";
import { searchDocs } from "@/lib/docs/search";
import { archiveDoc, assistantMayEdit, createDoc, editDoc, getDoc, listBacklinks, moveDoc, readDoc, renameDoc, shareDoc } from "@/lib/docs/store";
import { dailyHref, docHref, type DocDetail, type DocDiffLine, type DocEdit, type DocSummary } from "@/lib/docs/types";

type Args = Record<string, unknown>;
type Names = (id: unknown) => string;

export const SAVE_DOC_ACTIONS = ["create", "replace", "append", "edit", "rename", "move", "tag", "share", "unshare", "archive", "append_daily"] as const;
export type SaveDocAction = (typeof SAVE_DOC_ACTIONS)[number];

export const UNATTENDED_DOC_ACTIONS: readonly SaveDocAction[] = ["replace", "append", "edit", "tag"];

const PROVENANCE: Provenance = { operation: "save_doc", source: "assistant" };

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function raw(value: unknown) {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function actionOf(args: Args): SaveDocAction | null {
  const action = str(args.action);
  return (SAVE_DOC_ACTIONS as readonly string[]).includes(action) ? (action as SaveDocAction) : null;
}

function docIdOf(args: Args) {
  const id = str(args.docId);
  return isUuid(id) ? id : null;
}

export function editFrom(args: Args): DocEdit | null {
  const action = actionOf(args);
  if (action === "replace") return { action, content: raw(args.content) };
  if (action === "append") return { action, content: raw(args.content) };
  if (action === "edit") return { action, find: raw(args.find), replace: raw(args.replace), all: args.all === true };
  if (action === "tag") return { action, add: strings(args.addTags), remove: strings(args.removeTags) };
  return null;
}

const CARD_DIFF_LINES = 200;
const CARD_LINE_CHARS = 2_000;

function cardDiff(before: string, after: string) {
  return JSON.stringify(
    lineDiff(before, after, { maxLines: CARD_DIFF_LINES }).map((line) =>
      line.text.length > CARD_LINE_CHARS ? { ...line, text: `${line.text.slice(0, CARD_LINE_CHARS - 1)}…` } : line,
    ),
  );
}

export function diffKey(args: Args) {
  return `doc-diff:${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;
}

function whereLine(doc: DocDetail) {
  if (doc.kind === "daily") return "Your daily note, private to you.";
  const place = doc.path.length ? doc.path.map((step) => step.name).join(" › ") : "No folder";
  if (doc.visibility === "private") return `${place}, private to ${doc.ownedByMe ? "you" : doc.owner?.name ?? "its owner"}.`;
  return `${place}, shared with the workspace. Teammates and agents will see this change.`;
}

export async function docCardDetails(actor: UserActor, args: Args): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const action = actionOf(args);
  const key = diffKey(args);
  const docId = docIdOf(args);
  if (docId) {
    const doc = await getDoc(actor, docId).catch(() => null);
    if (doc) {
      out[docId] = doc.title || "Untitled doc";
      out[`${docId}:where`] = whereLine(doc);
      out[`${docId}:assistant`] = doc.assistantCanEdit ? "yes" : "no";
      const edit = editFrom(args);
      if (edit) {
        try {
          out[key] = cardDiff(doc.content, applyDocEdit(doc.content, edit));
        } catch (error) {
          if (error instanceof CrmError) out[`${key}:problem`] = error.message;
        }
      }
      if (action === "rename") out[`${key}:links`] = String((await listBacklinks(actor, docId).catch(() => [])).length);
    }
  }
  const folderId = str(args.folderId);
  if (isUuid(folderId)) {
    const folder = await getFolder(actor, folderId).catch(() => null);
    if (folder) {
      out[folderId] = folder.name;
      out[`${folderId}:shared`] = folder.effectiveShared ? "yes" : "no";
    }
  }
  if (action === "create" && raw(args.content)) out[key] = cardDiff("", raw(args.content));
  if (action === "append_daily") {
    const note = await getDailyNote(actor, str(args.date) || undefined).catch(() => null);
    const before = note?.page.content ?? "";
    const text = str(args.content);
    if (text) out[key] = cardDiff(before, appendDailyEntry(before, localTime(), text));
  }
  return out;
}

function known(name: Names, key: string) {
  const value = name(key);
  return value && value !== key ? value : null;
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function describeDocAction(args: Args, name: Names): { title: string; lines: string[]; diff?: DocDiffLine[] } {
  const action = actionOf(args);
  const docId = docIdOf(args);
  const key = diffKey(args);
  const doc = docId ? known(name, docId) ?? "a doc" : "a doc";
  const where = docId ? known(name, `${docId}:where`) : null;
  const stored = known(name, key);
  let diff: DocDiffLine[] | undefined;
  if (stored?.startsWith("[")) {
    try {
      diff = JSON.parse(stored) as DocDiffLine[];
    } catch {}
  }
  const problem = known(name, `${key}:problem`);
  const change = diff ? diffCounts(diff) : null;
  const changeLine = change && (change.added || change.removed) ? `${counted(change.added, "line", "lines")} added, ${counted(change.removed, "line", "lines")} removed.` : "";
  const folderId = str(args.folderId);
  const folder = isUuid(folderId) ? known(name, folderId) : null;
  const folderShared = isUuid(folderId) ? known(name, `${folderId}:shared`) === "yes" : false;
  const result = (title: string, lines: string[]) => ({ title, lines: lines.filter(Boolean), ...(diff ? { diff } : {}) });
  switch (action) {
    case "create":
      return result(`New doc: ${str(args.title) || "Untitled"}`, [
        folder ? `In ${folder}.` : "No folder.",
        args.shared === true || folderShared ? "Shared with the workspace. Teammates and agents will see it." : "Private to you.",
        changeLine,
      ]);
    case "replace":
      return result(`Rewrite ${doc}`, [where ?? "", changeLine, problem ? `This won't work yet: ${problem}` : ""]);
    case "append":
      return result(`Add to ${doc}`, [where ?? "", changeLine]);
    case "edit":
      return result(`Edit ${doc}`, [where ?? "", changeLine, problem ? `This won't work yet: ${problem}` : ""]);
    case "tag":
      return result(`Tag ${doc}`, [
        where ?? "",
        strings(args.addTags).length ? `Add ${strings(args.addTags).map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}` : "",
        strings(args.removeTags).length ? `Remove ${strings(args.removeTags).map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}` : "",
        problem ? `This won't work yet: ${problem}` : "",
      ]);
    case "rename": {
      const links = Number(known(name, `${key}:links`) ?? 0);
      return result(`Rename ${doc}`, [
        `New title: ${str(args.title)}`,
        where ?? "",
        links ? `Links to it in ${counted(links, "doc", "docs")} will be updated to the new title.` : "",
      ]);
    }
    case "move":
      return result(`Move ${doc}`, [
        folder ? `To ${folder}${folderShared ? ", which is shared with the workspace" : ""}.` : "Out of its folder.",
        where ?? "",
        args.allowVisibilityChange === true ? "This changes who can see it." : "",
      ]);
    case "share":
      return result(`Share ${doc} with the workspace`, ["Everyone in the workspace, and agents with Docs access, can read and edit it."]);
    case "unshare":
      return result(`Make ${doc} private`, ["Teammates and agents will no longer see it, unless its folder is shared."]);
    case "archive":
      return result(`Archive ${doc}`, [where ?? "", "It can be restored from Docs."]);
    case "append_daily":
      return result(str(args.date) ? `Add to your daily note for ${str(args.date)}` : "Add to today's daily note", [
        "Daily notes are always private to you.",
        args.meetings === true ? "With the day's meetings." : "",
      ]);
    default:
      return result("Save a doc", []);
  }
}

function summaryOf(doc: DocSummary) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    dailyDate: doc.dailyDate,
    visibility: doc.visibility,
    folderId: doc.folderId,
    tags: doc.tags,
    revision: doc.revision,
    assistantCanEdit: doc.assistantCanEdit,
    href: doc.kind === "daily" && doc.dailyDate ? dailyHref(doc.dailyDate) : docHref(doc.id),
  };
}

function requireDoc(args: Args) {
  const id = docIdOf(args);
  if (!id) throw new CrmError("invalid_input", "Say which doc with docId, from search_knowledge or a doc link.", 400, { field: "docId" });
  return id;
}

export async function editsWithoutApproval(actor: UserActor, name: string, args: Args) {
  if (name !== "save_doc") return false;
  const action = actionOf(args);
  if (!action || !UNATTENDED_DOC_ACTIONS.includes(action)) return false;
  const docId = docIdOf(args);
  if (!docId) return false;
  return assistantMayEdit(actor, docId);
}

export async function runDocAction(actor: UserActor, args: Args, context: { unattended?: boolean } = {}) {
  const action = actionOf(args);
  if (!action) throw new CrmError("invalid_input", `Choose an action: ${SAVE_DOC_ACTIONS.join(", ")}.`, 400, { field: "action" });
  if (context.unattended && !UNATTENDED_DOC_ACTIONS.includes(action)) {
    throw new CrmError("forbidden", "Only edits to a doc's text can run without approval. Propose this for approval instead.", 403);
  }
  const edit = editFrom(args);
  if (edit) {
    if (edit.action === "append" && !edit.content.trim()) {
      throw new CrmError("invalid_input", "Say what to add to the doc.", 400, { field: "content" });
    }
    const { doc, diff } = await editDoc(actor, requireDoc(args), edit, PROVENANCE, { assistantCanEdit: context.unattended === true });
    return { saved: true, doc: summaryOf(doc), changed: diffCounts(diff) };
  }
  if (action === "create") {
    const doc = await createDoc(actor, { title: str(args.title), content: raw(args.content), folderId: str(args.folderId) || null, shared: args.shared === true }, PROVENANCE);
    return { saved: true, doc: summaryOf(doc) };
  }
  if (action === "rename") {
    if (!str(args.title)) throw new CrmError("invalid_input", "Give the new title.", 400, { field: "title" });
    const result = await renameDoc(actor, requireDoc(args), str(args.title), PROVENANCE);
    return { saved: true, doc: summaryOf(result.doc), linksUpdated: result.linksUpdated };
  }
  if (action === "move") {
    const result = await moveDoc(actor, requireDoc(args), { folderId: str(args.folderId) || null, allowVisibilityChange: args.allowVisibilityChange === true }, PROVENANCE);
    return { saved: true, doc: summaryOf(result.page), visibility: result.visibility };
  }
  if (action === "share" || action === "unshare") {
    const result = await shareDoc(actor, requireDoc(args), action === "share", PROVENANCE);
    return { saved: true, doc: summaryOf(result.doc), visibility: result.visibility };
  }
  if (action === "archive") return { saved: true, doc: summaryOf(await archiveDoc(actor, requireDoc(args), PROVENANCE)) };
  const note = await appendToDailyNote(actor, { text: str(args.content), date: str(args.date) || undefined, meetings: args.meetings === true }, PROVENANCE);
  return { saved: true, doc: summaryOf(note.page), date: note.date };
}

export async function searchDocsForAssistant(actor: UserActor, query: string, limit: number) {
  const hits = await searchDocs(actor, query, { limit: Math.min(50, limit) });
  return hits.map((hit) => ({
    type: "doc" as const,
    docId: hit.id,
    title: hit.title || "Untitled doc",
    kind: hit.kind,
    dailyDate: hit.dailyDate,
    visibility: hit.visibility,
    mine: hit.ownedByMe,
    editedAt: hit.editedAt,
    text: hit.snippet,
    href: hit.kind === "daily" && hit.dailyDate ? dailyHref(hit.dailyDate) : docHref(hit.id),
  }));
}

export async function readDocForAssistant(actor: UserActor, docId: string, offset: number) {
  const result = await readDoc(actor, docId, offset);
  return {
    doc: { ...summaryOf(result.doc), owner: result.doc.owner?.name ?? null, mine: result.doc.ownedByMe, editedAt: result.doc.editedAt, characters: result.characters },
    offset: result.offset,
    text: result.text,
    nextOffset: result.nextOffset,
  };
}
