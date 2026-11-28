import { createHash } from "node:crypto";
import { Text } from "@codemirror/state";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { appendDailyEntry, localTime } from "@/lib/docs/daily";
import { appendToDailyNote, getDailyNote } from "@/lib/docs/daily-notes";
import { commentViews, deleteDocComment, listDocComments, replyToDocComment, setDocCommentResolved } from "@/lib/docs/comments";
import { changeCounts, lineDiff } from "@/lib/docs/diff";
import { applyDocEdit } from "@/lib/docs/edits";
import { getFolder } from "@/lib/docs/folders";
import { rebase } from "@/lib/docs/live/rebase";
import { applyEdits, textEdits, type TextEdit } from "@/lib/docs/live/text-diff";
import { searchDocs } from "@/lib/docs/search";
import { archiveDoc, assistantMayEdit, checkPublicEnding, createDoc, editDoc, getDoc, listBacklinks, moveDoc, readDoc, renameDoc, setDocPublic, shareDoc } from "@/lib/docs/store";
import { dailyHref, docHref, type DocDetail, type DocDiffLine, type DocEdit, type DocSummary } from "@/lib/docs/types";
import { toolSource } from "@/lib/assistant/source";
import { expiryDayLabel, expiryProblem } from "@/lib/docs/public-expiry";
import { ENDING_TAKEN, endingProblem } from "@/lib/docs/public-ending";
import { publicPath } from "@/lib/docs/public-link";
import { siteOrigin } from "@/lib/site-url";

type Args = Record<string, unknown>;
type Names = (id: unknown) => string;

export const SAVE_DOC_ACTIONS = ["create", "replace", "append", "edit", "rename", "move", "tag", "share", "unshare", "publish", "unpublish", "set_timer", "allow_download", "block_download", "allow_comments", "block_comments", "reply_comment", "resolve_comment", "reopen_comment", "delete_comment", "set_public_ending", "clear_public_ending", "archive", "append_daily"] as const;
export type SaveDocAction = (typeof SAVE_DOC_ACTIONS)[number];

export const UNATTENDED_DOC_ACTIONS: readonly SaveDocAction[] = ["replace", "append", "edit", "tag"];

function provenance(): Provenance {
  return { operation: "save_doc", source: toolSource() };
}

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

function timerOf(args: Args): { day: string | null; problem: string | null } {
  const day = str(args.expiresAt);
  if (!day) return { day: null, problem: null };
  const problem = expiryProblem(day);
  return { day: problem ? null : day, problem };
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
const UNDO_MAX = 200_000;

export type DocApproval = { matches?: number; base?: string; undo?: TextEdit[]; diff?: DocDiffLine[]; revision?: number; tasks?: Record<string, string> };

function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function countOf(content: string, find: string) {
  if (!find) return 0;
  let count = 0;
  for (let index = content.indexOf(find); index >= 0; index = content.indexOf(find, index + find.length)) count += 1;
  return count;
}

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

const PUBLIC_LINE = "Anyone with the public link will see this change.";

function whereLine(doc: DocDetail) {
  const exposure = doc.public ? ` ${PUBLIC_LINE}` : "";
  if (doc.kind === "daily") return `Your daily note, private to you.${exposure}`;
  const place = doc.path.length ? doc.path.map((step) => step.name).join(" › ") : "No folder";
  if (doc.visibility === "private") return `${place}, private to ${doc.ownedByMe ? "you" : doc.owner?.name ?? "its owner"}.${exposure}`;
  return `${place}, shared with the workspace. Teammates and agents will see this change.${exposure}`;
}

export async function docCardDetails(actor: UserActor, args: Args): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const action = actionOf(args);
  const key = diffKey(args);
  const docId = docIdOf(args);
  const commentId = str(args.commentId);
  if (docId && isUuid(commentId)) {
    const found = await listDocComments(actor, docId).catch(() => null);
    const comment = found?.comments.find((item) => item.id === commentId);
    if (comment) {
      out[commentId] = `${comment.authorName}: ${comment.body.replace(/\s+/g, " ").slice(0, 160)}`;
      out[`${commentId}:first`] = comment.parentId === null ? "yes" : "no";
    }
  }
  if (docId) {
    const doc = await getDoc(actor, docId).catch(() => null);
    if (doc) {
      out[docId] = doc.title || "Untitled doc";
      out[`${docId}:where`] = whereLine(doc);
      out[`${docId}:revision`] = String(doc.revision);
      out[`${docId}:public`] = doc.public ? "yes" : "no";
      out[`${docId}:download`] = doc.allowDownload ? "yes" : "no";
      out[`${docId}:comments`] = doc.allowComments ? "yes" : "no";
      const edit = editFrom(args);
      if (edit) {
        try {
          const after = applyDocEdit(doc.content, edit);
          out[key] = cardDiff(doc.content, after);
          out[`${key}:counts`] = JSON.stringify(changeCounts(doc.content, after));
          if (edit.action === "edit") out[`${key}:matches`] = String(countOf(doc.content, edit.find));
          if (edit.action === "replace") {
            out[`${key}:base`] = fingerprint(doc.content);
            const undo = JSON.stringify(textEdits(after, doc.content));
            if (undo.length <= UNDO_MAX) out[`${key}:undo`] = undo;
          }
        } catch (error) {
          if (error instanceof CrmError) out[`${key}:problem`] = error.message;
        }
      }
      if (action === "publish" || action === "set_timer") {
        const { day, problem } = timerOf(args);
        if (problem) out[`${key}:problem`] = problem;
        else if (action === "set_timer" && day && !doc.public) out[`${key}:problem`] = "The public link is off. Turn it on first.";
        else if (action === "set_timer" && !day && !str(args.expiresAt) && !doc.public) out[`${key}:problem`] = "The public link is off, so there is no timer to remove.";
      }
      if (action === "set_public_ending") {
        const problem = endingProblem(str(args.slug));
        if (problem) out[`${key}:problem`] = problem;
        else if (!doc.public) out[`${key}:problem`] = "The public link is off. Turn it on first.";
        else if (doc.publicSlug !== str(args.slug).toLowerCase()) {
          const status = await checkPublicEnding(actor, docId, str(args.slug)).catch(() => null);
          if (status?.status === "taken") out[`${key}:problem`] = ENDING_TAKEN;
        }
      }
      if (action === "clear_public_ending" && !doc.public) out[`${key}:problem`] = "The public link is off. Turn it on first.";
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
  if (action === "create" && raw(args.content)) {
    out[key] = cardDiff("", raw(args.content));
    out[`${key}:counts`] = JSON.stringify(changeCounts("", raw(args.content)));
  }
  if (action === "append_daily") {
    const note = await getDailyNote(actor, str(args.date) || undefined).catch(() => null);
    const before = note?.page.content ?? "";
    const text = str(args.content);
    if (text) {
      const after = appendDailyEntry(before, localTime(), text);
      out[key] = cardDiff(before, after);
      out[`${key}:counts`] = JSON.stringify(changeCounts(before, after));
    }
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

function storedCounts(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { added?: unknown; removed?: unknown };
    return typeof parsed.added === "number" && typeof parsed.removed === "number" ? { added: parsed.added, removed: parsed.removed } : null;
  } catch {
    return null;
  }
}

function storedUndo(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as TextEdit[]) : undefined;
  } catch {
    return undefined;
  }
}

function approvalOf(args: Args, name: Names, key: string): DocApproval | undefined {
  const action = actionOf(args);
  if (action === "edit") {
    const matches = Number(known(name, `${key}:matches`));
    return Number.isInteger(matches) && matches > 0 ? { matches } : undefined;
  }
  if (action === "replace") {
    const base = known(name, `${key}:base`);
    if (!base) return undefined;
    const undo = storedUndo(known(name, `${key}:undo`));
    return undo ? { base, undo } : { base };
  }
  return undefined;
}

export function describeDocAction(args: Args, name: Names): { title: string; lines: string[]; diff?: DocDiffLine[]; approval?: DocApproval } {
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
  const change = storedCounts(known(name, `${key}:counts`));
  const approval = approvalOf(args, name, key);
  const changeLine = change && (change.added || change.removed) ? `${counted(change.added, "line", "lines")} added, ${counted(change.removed, "line", "lines")} removed.` : "";
  const folderId = str(args.folderId);
  const folder = isUuid(folderId) ? known(name, folderId) : null;
  const folderShared = isUuid(folderId) ? known(name, `${folderId}:shared`) === "yes" : false;
  const result = (title: string, lines: string[]) => ({
    title,
    lines: lines.filter(Boolean),
    ...(diff ? { diff } : {}),
    ...(approval ? { approval } : {}),
  });
  switch (action) {
    case "create":
      return result(`New note: ${str(args.title) || "Untitled"}`, [
        folder ? `In ${folder}.` : "No folder.",
        args.shared === true || folderShared ? "Shared with the workspace and its agents." : "Private to you.",
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
        links ? `Updates links in ${counted(links, "note", "notes")}.` : "",
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
    case "publish": {
      const download = docId ? known(name, `${docId}:download`) === "yes" : false;
      const comments = docId ? known(name, `${docId}:comments`) === "yes" : false;
      const { day } = timerOf(args);
      const until = day && !problem ? expiryDayLabel(day) : null;
      return result(until ? `Turn on the public link until ${until}` : "Turn on the public link", [
        doc,
        `Anyone with the link can read it${until ? ` until ${until}` : ""}. ${download ? "Download is on." : "Download stays off."} ${comments ? "Comments are on." : "Comments stay off."}`,
        problem ? `This won't work yet: ${problem}` : "",
      ]);
    }
    case "set_timer": {
      const { day } = timerOf(args);
      if (!str(args.expiresAt)) return result("Remove the timer on the public link", [doc, problem ? `This won't work yet: ${problem}` : "The link stays on until someone turns it off."]);
      return result(day && !problem ? `Turn off the public link on ${expiryDayLabel(day)}` : "Turn off the public link on a date", [
        doc,
        day && !problem ? `It stops working at midnight UK time at the end of ${expiryDayLabel(day)}.` : "",
        problem ? `This won't work yet: ${problem}` : "",
      ]);
    }
    case "unpublish":
      return result("Turn off the public link", [doc, "The link will show not found until it's turned on again."]);
    case "allow_download": {
      const live = docId ? known(name, `${docId}:public`) === "yes" : true;
      return result("Allow download", [doc, "Readers can download it as a PDF.", live ? "" : "The public link is off, so nobody can read it yet."]);
    }
    case "block_download":
      return result("Stop downloads", [doc, "Readers can no longer download it as a PDF."]);
    case "allow_comments": {
      const live = docId ? known(name, `${docId}:public`) === "yes" : true;
      return result("Allow comments", [doc, "Readers can comment and reply. Everyone on the link sees them.", live ? "" : "The public link is off, so nobody can read it yet."]);
    }
    case "block_comments":
      return result("Stop comments", [doc, "Readers can no longer comment or reply. Existing comments are kept."]);
    case "reply_comment": {
      const said = str(args.content).replace(/\s+/g, " ");
      return result(`Reply to a comment on ${doc}`, [
        said ? `"${said.length > 200 ? `${said.slice(0, 200)}...` : said}"` : "",
        "Everyone with the public link sees the reply under your name.",
      ]);
    }
    case "resolve_comment":
      return result(`Resolve a comment on ${doc}`, [known(name, str(args.commentId)) ?? "", "It leaves the margin of the public page."]);
    case "reopen_comment":
      return result(`Reopen a comment on ${doc}`, [known(name, str(args.commentId)) ?? "", "It comes back to the margin of the public page."]);
    case "delete_comment":
      return result(`Delete a comment on ${doc}`, [known(name, str(args.commentId)) ?? "", `It is removed from the public page too${known(name, `${str(args.commentId)}:first`) === "yes" ? ", with its replies," : ""} and can't be brought back.`]);
    case "set_public_ending": {
      const slug = str(args.slug).toLowerCase();
      return result(`Change the public link to ${(siteOrigin() ?? "").replace(/^https?:\/\//, "")}${publicPath(slug)}`, [
        doc,
        "The random link and earlier endings forward to it.",
        problem ? `This won't work yet: ${problem}` : "",
      ]);
    }
    case "clear_public_ending":
      return result("Go back to the random public link", [doc, "Earlier endings forward to it.", problem ? `This won't work yet: ${problem}` : ""]);
    case "archive":
      return result(`Archive ${doc}`, [where ?? ""]);
    case "append_daily":
      return result(str(args.date) ? `Add to your daily note for ${str(args.date)}` : "Add to today's daily note", [
        "Private to you.",
        args.meetings === true ? "With the day's meetings." : "",
      ]);
    default:
      return result("Save a note", []);
  }
}

function summaryOf(doc: DocSummary) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    dailyDate: doc.dailyDate,
    visibility: doc.visibility,
    public: doc.public,
    allowDownload: doc.allowDownload,
    allowComments: doc.allowComments,
    openComments: doc.openComments,
    publicUrl: doc.publicUrl,
    publicSlug: doc.publicSlug,
    publicExpiresAt: doc.publicExpiresAt,
    folderId: doc.folderId,
    tags: doc.tags,
    revision: doc.revision,
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

export const CHANGED_SINCE_APPROVAL = "The note changed since this was proposed, so it wasn't applied. Read the note again and propose the change again.";

export const CHANGED_SINCE_APPROVAL_CARD = "The note changed since this was proposed, so it wasn't applied. Ask again.";

export function docRefusalForCard(message: string) {
  return message === CHANGED_SINCE_APPROVAL ? CHANGED_SINCE_APPROVAL_CARD : message;
}

function refuse(message: string) {
  return new CrmError("conflict", message, 409);
}

export function approvalFor(action: { approval?: DocApproval; diff?: DocDiffLine[]; baseRevision?: number }): DocApproval | undefined {
  if (!action.approval && action.baseRevision === undefined && !action.diff) return undefined;
  return {
    ...(action.approval ?? {}),
    ...(action.diff ? { diff: action.diff } : {}),
    ...(action.baseRevision !== undefined ? { revision: action.baseRevision } : {}),
  };
}

function lineSpans(text: string, edits: TextEdit[]) {
  return edits.map((edit) => {
    const end = text.indexOf("\n", edit.at + edit.remove);
    return { from: edit.at === 0 ? 0 : text.lastIndexOf("\n", edit.at - 1) + 1, to: end < 0 ? text.length : end };
  });
}

function overlapping(base: string, left: TextEdit[], right: TextEdit[]) {
  const theirs = lineSpans(base, right);
  return lineSpans(base, left).some((one) => theirs.some((other) => one.from <= other.to && other.from <= one.to));
}

export function mergeRewrite(base: string, proposed: string, current: string) {
  if (overlapping(base, textEdits(base, proposed), textEdits(base, current))) return null;
  return rebase(base, proposed, current).toShared.apply(Text.of(current.split("\n"))).toString();
}

function approvedEdit(edit: Extract<DocEdit, { action: "edit" }>, approval: DocApproval) {
  return (current: string) => {
    if (approval.matches !== undefined && countOf(current, edit.find) !== approval.matches) throw refuse(CHANGED_SINCE_APPROVAL);
    let after: string;
    try {
      after = applyDocEdit(current, edit);
    } catch {
      throw refuse(CHANGED_SINCE_APPROVAL);
    }
    if (approval.diff && cardDiff(current, after) !== JSON.stringify(approval.diff)) throw refuse(CHANGED_SINCE_APPROVAL);
    return after;
  };
}

function approvedRewrite(proposed: string, approval: DocApproval & { base: string }) {
  return (current: string) => {
    if (fingerprint(current) === approval.base) return proposed;
    const base = approval.undo ? applyEdits(proposed, approval.undo) : null;
    if (base === null || fingerprint(base) !== approval.base) throw refuse(CHANGED_SINCE_APPROVAL);
    const merged = mergeRewrite(base, proposed, current);
    if (merged === null) throw refuse(CHANGED_SINCE_APPROVAL);
    return merged;
  };
}

function approvedPlan(edit: DocEdit, approval: DocApproval | undefined) {
  if (!approval) return {};
  if (edit.action === "edit") return { plan: approvedEdit(edit, approval) };
  if (edit.action === "replace") {
    if (approval.base) return { plan: approvedRewrite(edit.content, { ...approval, base: approval.base }) };
    return approval.revision !== undefined ? { baseRevision: approval.revision } : {};
  }
  return {};
}

export async function runDocAction(actor: UserActor, args: Args, context: { unattended?: boolean; approval?: DocApproval } = {}) {
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
    try {
      const { doc, changed } = await editDoc(actor, requireDoc(args), edit, provenance(), {
        assistantCanEdit: context.unattended === true,
        ...(context.unattended ? {} : approvedPlan(edit, context.approval)),
      });
      return { saved: true, doc: summaryOf(doc), changed };
    } catch (error) {
      if (error instanceof CrmError && error.code === "conflict") throw refuse(CHANGED_SINCE_APPROVAL);
      throw error;
    }
  }
  if (action === "create") {
    const doc = await createDoc(actor, { title: str(args.title), content: raw(args.content), folderId: str(args.folderId) || null, shared: args.shared === true }, provenance());
    return { saved: true, doc: summaryOf(doc) };
  }
  if (action === "rename") {
    if (!str(args.title)) throw new CrmError("invalid_input", "Give the new title.", 400, { field: "title" });
    const result = await renameDoc(actor, requireDoc(args), str(args.title), provenance());
    return { saved: true, doc: summaryOf(result.doc), linksUpdated: result.linksUpdated };
  }
  if (action === "move") {
    const result = await moveDoc(actor, requireDoc(args), { folderId: str(args.folderId) || null, allowVisibilityChange: args.allowVisibilityChange === true }, provenance());
    return { saved: true, doc: summaryOf(result.page), visibility: result.visibility };
  }
  if (action === "share" || action === "unshare") {
    const result = await shareDoc(actor, requireDoc(args), action === "share", provenance());
    return { saved: true, doc: summaryOf(result.doc), visibility: result.visibility };
  }
  if (action === "reply_comment" || action === "resolve_comment" || action === "reopen_comment" || action === "delete_comment") {
    const docId = requireDoc(args);
    const commentId = str(args.commentId);
    if (!isUuid(commentId)) throw new CrmError("invalid_input", "Say which comment with commentId, from read_knowledge.", 400, { field: "commentId" });
    if (action === "reply_comment") return { saved: true, comment: await replyToDocComment(actor, docId, commentId, { body: raw(args.content) }, provenance()) };
    if (action === "delete_comment") return { saved: true, ...(await deleteDocComment(actor, docId, commentId, provenance())) };
    return { saved: true, comment: await setDocCommentResolved(actor, docId, commentId, action === "resolve_comment", provenance()) };
  }
  if (action === "publish" || action === "unpublish" || action === "set_timer" || action === "allow_download" || action === "block_download" || action === "allow_comments" || action === "block_comments") {
    const timer = action === "publish" || action === "set_timer" ? timerOf(args) : { day: null, problem: null };
    if (timer.problem) throw new CrmError("invalid_input", timer.problem, 400, { field: "expiresAt" });
    const docId = requireDoc(args);
    if (action === "set_timer" && !timer.day && !(await getDoc(actor, docId)).public) {
      throw new CrmError("invalid_input", "The public link is off, so there is no timer to remove.", 400, { field: "expiresAt" });
    }
    const input =
      action === "publish"
        ? { public: true, ...(timer.day ? { expiresAt: timer.day } : {}) }
        : action === "unpublish"
          ? { public: false }
          : action === "set_timer"
            ? { expiresAt: timer.day }
            : action === "allow_download" || action === "block_download"
              ? { allowDownload: action === "allow_download" }
              : { allowComments: action === "allow_comments" };
    return { saved: true, doc: summaryOf(await setDocPublic(actor, docId, input, provenance())) };
  }
  if (action === "set_public_ending" || action === "clear_public_ending") {
    const slug = action === "set_public_ending" ? str(args.slug) : null;
    return { saved: true, doc: summaryOf(await setDocPublic(actor, requireDoc(args), { slug }, provenance())) };
  }
  if (action === "archive") return { saved: true, doc: summaryOf(await archiveDoc(actor, requireDoc(args), provenance())) };
  const note = await appendToDailyNote(actor, { text: str(args.content), date: str(args.date) || undefined, meetings: args.meetings === true }, provenance());
  return { saved: true, doc: summaryOf(note.page), date: note.date, ...(note.meetingsError ? { warning: note.meetingsError } : {}) };
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
  const comments = result.offset === 0 && result.doc.commentCount > 0 ? await listDocComments(actor, docId) : null;
  return {
    doc: { ...summaryOf(result.doc), owner: result.doc.owner?.name ?? null, mine: result.doc.ownedByMe, editedAt: result.doc.editedAt, characters: result.characters },
    offset: result.offset,
    text: result.text,
    nextOffset: result.nextOffset,
    ...(comments ? { comments: commentViews(comments.comments, comments.text) } : {}),
  };
}
