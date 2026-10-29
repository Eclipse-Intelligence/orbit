import { CrmError } from "@/lib/crm/errors";
import type { Provenance, UserActor } from "@/lib/crm/types";
import type { CreateInput, Folder, Page, PageFilter, PageSort, ShareTarget, Visibility } from "@/lib/docs/client-types";
import { isDailyDate } from "@/lib/docs/daily";
import { createFolder, listFolders, moveFolder, renameFolder, shareFolder } from "@/lib/docs/folders";
import { liveTransport } from "@/lib/docs/live/broadcast";
import { LIVE_BODY_MAX, LIVE_UPDATE_MAX, LIVE_VECTOR_MAX } from "@/lib/docs/live/persist";
import { decodeBytes, encodeBytes } from "@/lib/docs/live/ydoc";
import {
  archiveDoc,
  createDoc,
  moveDoc,
  openLiveDoc,
  pagingNumber,
  renameDoc,
  restoreDoc,
  restoreVersion,
  saveDoc,
  setAssistantCanEdit,
  shareDoc,
  syncLiveDoc,
} from "@/lib/docs/store";
import {
  docsActivity,
  docsBacklinks,
  docsDailyList,
  docsDailyNote,
  docsLinkTargets,
  docsListPage,
  docsMeetings,
  docsMentions,
  docsNav,
  docsNoteTitles,
  docsPage,
  docsRecent,
  docsRecordDetails,
  docsSearch,
  docsTitles,
  docsVersionBody,
  docsVersions,
  toFolder,
  toPage,
  toSummary,
} from "@/lib/docs/view";
import { MENTION_KINDS, type MentionKind } from "@/lib/mentions";

const PROVENANCE: Provenance = { operation: "docs.app" };
const SORTS: PageSort[] = ["edited", "created", "title"];
const NOT_FOUND = "That note doesn't exist any more, or it's private to someone else.";
const BODY_MAX = 8_000_000;
const LIVE_TOO_LARGE = "This change is too big to send live. Orbit will save the note the usual way instead.";

export type DocsActionResult<T> = { data: T; error?: undefined } | { error: string; code?: string; details?: Record<string, unknown> | null };

export type DocsCall = { actor: UserActor; request: Request; params: Record<string, string> };

function search(request: Request) {
  return new URL(request.url).searchParams;
}

function filterFrom(params: URLSearchParams): PageFilter {
  const list = params.get("list");
  if (list === "folder" && params.get("folder")) return { kind: "folder", folderId: params.get("folder")! };
  if (list === "tag" && params.get("tag")) return { kind: "tag", path: params.get("tag")! };
  if (list === "daily") return { kind: "daily" };
  if (list === "search") return { kind: "search", query: params.get("q") ?? "" };
  return { kind: "all" };
}

async function limitedText(request: Request, limit: number, tooLarge: () => CrmError) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function tooLargeBody() {
  return new CrmError("too_large", "That request was too big for Docs. Split the note into smaller notes and try again.", 413);
}

function tooLargeLive() {
  return new CrmError("live_too_large", LIVE_TOO_LARGE, 413);
}

async function body(request: Request, limit = BODY_MAX, tooLarge = tooLargeBody): Promise<Record<string, unknown>> {
  const text = await limitedText(request, limit, tooLarge);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new CrmError("invalid_input", "The request wasn't valid JSON. Reload the page and try again.", 400);
  }
}

function liveBytes(value: unknown, limit: number) {
  if (typeof value === "string" && value.length > 4 * Math.ceil(limit / 3)) throw tooLargeLive();
  const bytes = decodeBytes(value);
  if (bytes && bytes.length > limit) throw tooLargeLive();
  if (value !== undefined && value !== null && value !== "" && !bytes) {
    throw new CrmError("live_invalid", "That change couldn't be read, so it wasn't saved. Reload the note and try again.", 400);
  }
  return bytes;
}

function dateParam(value: string | undefined | null) {
  if (!isDailyDate(value)) throw new CrmError("invalid_input", "Give the day as YYYY-MM-DD, for example 2026-10-29.", 400, { field: "date" });
  return value;
}

async function requirePage(actor: UserActor, id: string) {
  const page = await docsPage(actor, id);
  if (!page) throw new CrmError("not_found", NOT_FOUND, 404);
  return page;
}

function refsFrom(raw: string | null) {
  return (raw ?? "")
    .split(",")
    .slice(0, 50)
    .map((part) => part.split(":"))
    .filter((parts): parts is [MentionKind, string] => parts.length === 2 && (MENTION_KINDS as readonly string[]).includes(parts[0]))
    .map(([kind, id]) => ({ kind, id, name: "" }));
}

export const docsReads = {
  nav: ({ actor }: DocsCall) => docsNav(actor),
  list: ({ actor, request }: DocsCall) => {
    const params = search(request);
    const sort = params.get("sort") as PageSort | null;
    const offset = pagingNumber(params.get("offset"), 0, 0, 10_000);
    const result = docsListPage(actor, filterFrom(params), sort && SORTS.includes(sort) ? sort : "edited", offset);
    return params.get("paged") === "1" ? result : result.then((page) => page.pages);
  },
  recent: ({ actor, request }: DocsCall) => docsRecent(actor, pagingNumber(search(request).get("limit"), 8, 1, 50)),
  search: ({ actor, request }: DocsCall) => docsSearch(actor, search(request).get("q") ?? ""),
  page: ({ actor, params }: DocsCall) => requirePage(actor, params.id),
  versions: ({ actor, params }: DocsCall) => docsVersions(actor, params.id),
  version: ({ actor, params }: DocsCall) => docsVersionBody(actor, params.id, params.versionId),
  backlinks: ({ actor, params }: DocsCall) => docsBacklinks(actor, params.id),
  linkTargets: ({ actor, request }: DocsCall) => docsLinkTargets(actor, search(request).get("q") ?? "", search(request).get("from")),
  titles: ({ actor }: DocsCall) => docsTitles(actor),
  noteTitles: ({ actor }: DocsCall) => docsNoteTitles(actor),
  mentioning: ({ actor, request }: DocsCall) => docsMentions(actor, { kind: search(request).get("kind") ?? "", id: search(request).get("id") ?? "" }),
  records: ({ actor, request }: DocsCall) => docsRecordDetails(actor, refsFrom(search(request).get("refs"))),
  daily: ({ actor }: DocsCall) => docsDailyList(actor),
  meetings: ({ actor, request }: DocsCall) => docsMeetings(actor, dateParam(search(request).get("date"))),
  activity: ({ actor }: DocsCall) => docsActivity(actor),
  async live({ actor, params }: DocsCall) {
    const opened = await openLiveDoc(actor, params.id);
    return { state: encodeBytes(opened.state), generation: opened.generation, revision: opened.doc.revision, title: opened.doc.title, transport: liveTransport() };
  },
};

export const docsWrites = {
  async save({ actor, request, params }: DocsCall) {
    const input = await body(request);
    const baseRevision = typeof input.baseRevision === "number" ? input.baseRevision : undefined;
    try {
      const doc = await saveDoc(
        actor,
        params.id,
        {
          title: typeof input.title === "string" ? input.title : undefined,
          content: typeof input.body === "string" ? input.body : undefined,
          baseRevision,
          overwrite: input.overwrite === true,
        },
        PROVENANCE,
      );
      return { page: toPage(actor, doc) };
    } catch (error) {
      if (error instanceof CrmError && error.code === "conflict") {
        const latest = await docsPage(actor, params.id);
        return Response.json(
          { error: "Someone else changed this note while you were editing.", code: "conflict", page: latest },
          { status: 409, headers: { "cache-control": "private, no-store" } },
        );
      }
      throw error;
    }
  },
  openDaily: ({ actor, params }: DocsCall) => docsDailyNote(actor, dateParam(params.date)),
  async liveSync({ actor, request, params }: DocsCall) {
    const input = await body(request, LIVE_BODY_MAX, tooLargeLive);
    const result = await syncLiveDoc(
      actor,
      params.id,
      {
        update: liveBytes(input.update, LIVE_UPDATE_MAX),
        vector: liveBytes(input.vector, LIVE_VECTOR_MAX),
        title: typeof input.title === "string" ? input.title : undefined,
        generation: typeof input.generation === "number" && Number.isInteger(input.generation) ? input.generation : undefined,
      },
      PROVENANCE,
    );
    return {
      vector: encodeBytes(result.vector),
      missing: encodeBytes(result.missing),
      generation: result.generation,
      rebuilt: result.rebuilt,
      revision: result.doc.revision,
      summary: toSummary(actor, result.doc),
    };
  },
};

export async function docsRespond(actor: UserActor | null, run: (actor: UserActor) => Promise<unknown>): Promise<Response> {
  if (!actor) return Response.json({ error: "Your session ended. Sign in again to keep working on Docs." }, { status: 401 });
  try {
    const result = await run(actor);
    if (result instanceof Response) return result;
    return Response.json(result ?? null, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    console.error("docs request failed", error);
    return Response.json({ error: "Docs didn't respond. Try again in a moment." }, { status: 500 });
  }
}

export async function docsAction<T>(actor: UserActor | null, run: (actor: UserActor) => Promise<T>): Promise<DocsActionResult<T>> {
  if (!actor) return { error: "Your session ended. Sign in again to keep working on Docs." };
  try {
    return { data: await run(actor) };
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, code: error.code, details: error.details };
    console.error("docs action failed", error);
    return { error: "That didn't work. Try again in a moment." };
  }
}

async function foldersOf(actor: UserActor): Promise<Folder[]> {
  return (await listFolders(actor)).map((folder) => toFolder(actor, folder));
}

export const docsChanges = {
  async create(actor: UserActor, input: CreateInput): Promise<Page> {
    return toPage(actor, await createDoc(actor, { title: input.title, content: input.body, folderId: input.folderId ?? null }, PROVENANCE));
  },
  async rename(actor: UserActor, id: string, title: string) {
    const result = await renameDoc(actor, id, title, PROVENANCE);
    return { page: toPage(actor, result.doc), linksUpdated: result.linksUpdated };
  },
  async move(actor: UserActor, id: string, folderId: string | null, allowVisibilityChange: boolean): Promise<Page> {
    await moveDoc(actor, id, { folderId, allowVisibilityChange }, PROVENANCE);
    return requirePage(actor, id);
  },
  async archive(actor: UserActor, id: string) {
    await archiveDoc(actor, id, PROVENANCE);
    return { archived: true };
  },
  async restore(actor: UserActor, id: string): Promise<Page> {
    return toPage(actor, await restoreDoc(actor, id, PROVENANCE));
  },
  async assistantCanEdit(actor: UserActor, id: string, value: boolean): Promise<Page> {
    return toPage(actor, await setAssistantCanEdit(actor, id, value));
  },
  async createFolder(actor: UserActor, name: string, parentId: string | null): Promise<Folder> {
    return toFolder(actor, await createFolder(actor, { name, parentId }, PROVENANCE));
  },
  async renameFolder(actor: UserActor, id: string, name: string): Promise<Folder> {
    return toFolder(actor, await renameFolder(actor, id, name, PROVENANCE));
  },
  async moveFolder(actor: UserActor, id: string, parentId: string | null, position: number, allowVisibilityChange: boolean): Promise<Folder[]> {
    await moveFolder(actor, id, { parentId, index: position, allowVisibilityChange }, PROVENANCE);
    return foldersOf(actor);
  },
  async share(actor: UserActor, target: ShareTarget, visibility: Visibility) {
    if (target.kind === "folder") await shareFolder(actor, target.id, visibility === "shared", PROVENANCE);
    else await shareDoc(actor, target.id, visibility === "shared", PROVENANCE);
    return { shared: visibility === "shared" };
  },
  async restoreVersion(actor: UserActor, pageId: string, versionId: string): Promise<Page> {
    return toPage(actor, await restoreVersion(actor, pageId, versionId, PROVENANCE));
  },
};
