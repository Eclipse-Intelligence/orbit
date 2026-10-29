import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor, Provenance } from "@/lib/crm/types";
import { appendToDailyNote, listDailyNotes, openDailyNote } from "@/lib/docs/daily-notes";
import { createFolder, listFolders } from "@/lib/docs/folders";
import { searchDocs } from "@/lib/docs/search";
import {
  archiveDoc,
  createDoc,
  editDoc,
  getDoc,
  listBacklinks,
  listDocs,
  listVersions,
  moveDoc,
  readDoc,
  renameDoc,
  restoreDoc,
  restoreVersion,
  shareDoc,
} from "@/lib/docs/store";
import { DOC_CONTENT_MAX, DOC_SORTS, type DocDetail, type DocSummary } from "@/lib/docs/types";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The Docs request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

function provenance(operation: string, url?: string | null): Provenance {
  return { operation, source: "mcp", sourceUrl: url ?? null };
}

function summary(doc: DocSummary) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    dailyDate: doc.dailyDate,
    folderId: doc.folderId,
    owner: doc.owner?.name ?? null,
    mine: doc.ownedByMe,
    visibility: doc.visibility,
    tags: doc.tags,
    excerpt: doc.excerpt,
    wordCount: doc.wordCount,
    revision: doc.revision,
    editedAt: doc.editedAt,
    lastEditor: doc.lastEditor?.name ?? null,
    archivedAt: doc.archivedAt,
  };
}

function detail(doc: DocDetail) {
  return {
    ...summary(doc),
    path: doc.path.map((step) => step.name),
    links: doc.links.map((link) => ({ title: link.title, heading: link.heading, docId: link.pageId, archived: link.archived })),
    mentions: doc.mentions,
  };
}

const provenanceUrl = z.string().max(1000).nullable().optional().describe("Where this came from, for the audit trail.");

export function registerDocsTools(server: McpServer, actor: Actor) {
  const personal = actor.type === "user";
  const who = personal
    ? "This person's own docs and every doc shared with the workspace."
    : "Only docs shared with the workspace; private docs and daily notes are never visible to an agent token.";

  server.registerTool(
    "list_doc_folders",
    { description: `Docs folders, nested by parentId and ordered by position, with who owns each and whether it is shared. ${who}`, inputSchema: { archived: z.boolean().optional() } },
    async (args) =>
      run(async () => ({
        folders: (await listFolders(actor, { archived: args.archived })).map((folder) => ({
          id: folder.id,
          parentId: folder.parentId,
          name: folder.name,
          position: folder.position,
          owner: folder.owner?.name ?? null,
          visibility: folder.visibility,
          docs: folder.pageCount,
        })),
      })),
  );

  server.registerTool(
    "create_doc_folder",
    {
      description: "Creates a Docs folder, at the top level or inside another. A folder inside a shared folder is shared too. Agent tokens can only create shared folders.",
      inputSchema: { name: z.string().min(1).max(200), parent_id: z.uuid().optional(), shared: z.boolean().optional(), provenanceUrl },
    },
    async (args) => run(async () => ({ folder: await createFolder(actor, { name: args.name, parentId: args.parent_id, shared: args.shared }, provenance("create_doc_folder", args.provenanceUrl)) })),
  );

  server.registerTool(
    "list_docs",
    {
      description: `Docs, newest edit first unless sorted otherwise, with excerpts and tags. Filter by folder (folder_id, or no_folder true for docs not in a folder you can see) or by a tag, which includes its nested tags. ${who}`,
      inputSchema: {
        folder_id: z.uuid().optional(),
        no_folder: z.boolean().optional(),
        tag: z.string().max(100).optional(),
        sort: z.enum(DOC_SORTS).optional(),
        archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const result = await listDocs(actor, {
          folderId: args.no_folder ? null : args.folder_id,
          tag: args.tag,
          sort: args.sort,
          archived: args.archived,
          limit: args.limit,
          offset: args.offset,
        });
        return { docs: result.data.map(summary), hasMore: result.hasMore };
      }),
  );

  server.registerTool(
    "search_docs",
    {
      description: `Searches Docs by title (prefix and fuzzy) and full text. An empty query lists recent docs. ${who}`,
      inputSchema: { query: z.string().max(200), limit: z.number().int().min(1).max(50).optional() },
    },
    async (args) => run(async () => ({ results: await searchDocs(actor, args.query, { limit: args.limit, daily: personal }) })),
  );

  server.registerTool(
    "read_doc",
    {
      description:
        "Reads one doc as Markdown, 100,000 characters at a time from offset, with nextOffset until it is null. The first window also has its folder path, links, @ mentions and the docs that link to it. Docs link with [[Title]], tag with #tag and mention records as @[Name](company:id).",
      inputSchema: { id: z.uuid(), offset: z.number().int().min(0).max(DOC_CONTENT_MAX).optional() },
    },
    async (args) =>
      run(async () => {
        const read = await readDoc(actor, args.id, args.offset ?? 0);
        if (read.offset > 0) return { doc: summary(read.doc), offset: read.offset, text: read.text, characters: read.characters, nextOffset: read.nextOffset };
        const [doc, backlinks] = await Promise.all([getDoc(actor, args.id), listBacklinks(actor, args.id)]);
        return {
          doc: detail(doc),
          backlinks: backlinks.map((link) => ({ id: link.id, title: link.title, snippet: link.snippet })),
          offset: 0,
          text: read.text,
          characters: read.characters,
          nextOffset: read.nextOffset,
        };
      }),
  );

  server.registerTool(
    "create_doc",
    {
      description:
        "Creates a doc. It is private to a personal token's owner unless shared or put in a shared folder. Agent tokens always create shared docs with no owner, so they stay shared even if their folder is made private.",
      inputSchema: {
        title: z.string().max(300),
        content: z.string().max(1_000_000).optional(),
        folder_id: z.uuid().optional(),
        shared: z.boolean().optional(),
        provenanceUrl,
      },
    },
    async (args) =>
      run(async () => ({ doc: detail(await createDoc(actor, { title: args.title, content: args.content, folderId: args.folder_id, shared: args.shared }, provenance("create_doc", args.provenanceUrl))) })),
  );

  server.registerTool(
    "update_doc",
    {
      description:
        "Changes a doc's text: mode replace (content is the whole new text), append (content goes at the end), or edit (find exact existing text and replace it; all for every match). Pass base_revision from read_doc to refuse the change if someone edited it since. Orbit saves a version before and after every agent edit.",
      inputSchema: {
        id: z.uuid(),
        mode: z.enum(["replace", "append", "edit"]),
        content: z.string().max(1_000_000).optional(),
        find: z.string().max(100_000).optional(),
        replace: z.string().max(100_000).optional(),
        all: z.boolean().optional(),
        base_revision: z.number().int().min(1).optional(),
        provenanceUrl,
      },
    },
    async (args) =>
      run(async () => {
        const edit =
          args.mode === "edit"
            ? { action: "edit" as const, find: args.find ?? "", replace: args.replace ?? "", all: args.all }
            : { action: args.mode, content: args.content ?? "" };
        if (edit.action === "append" && !edit.content.trim()) throw new CrmError("invalid_input", "Give the content to add.", 400, { field: "content" });
        if (edit.action === "replace" && args.content === undefined) {
          throw new CrmError("invalid_input", "Give content, the whole new text of the doc. To empty it on purpose, send content as an empty string.", 400, { field: "content" });
        }
        const result = await editDoc(actor, args.id, edit, provenance("update_doc", args.provenanceUrl), { baseRevision: args.base_revision });
        return { doc: summary(result.doc), changed: result.changed };
      }),
  );

  server.registerTool(
    "rename_doc",
    {
      description: "Renames a doc and rewrites [[Old title]] links to it in every doc you can see, saving a version of each.",
      inputSchema: { id: z.uuid(), title: z.string().min(1).max(300), provenanceUrl },
    },
    async (args) =>
      run(async () => {
        const result = await renameDoc(actor, args.id, args.title, provenance("rename_doc", args.provenanceUrl));
        return { doc: summary(result.doc), linksUpdated: result.linksUpdated };
      }),
  );

  server.registerTool(
    "move_doc",
    {
      description:
        "Moves a doc into a folder, or out of folders with folder_id null. A move that shares the doc or makes it private is refused with visibility_change unless allow_visibility_change is true. Only the owner can move a doc somewhere private.",
      inputSchema: { id: z.uuid(), folder_id: z.uuid().nullable(), allow_visibility_change: z.boolean().optional(), provenanceUrl },
    },
    async (args) =>
      run(async () => {
        const result = await moveDoc(actor, args.id, { folderId: args.folder_id, allowVisibilityChange: args.allow_visibility_change }, provenance("move_doc", args.provenanceUrl));
        return { doc: summary(result.page), visibility: result.visibility };
      }),
  );

  server.registerTool(
    "tag_doc",
    {
      description: "Adds inline #tags to a doc (on a tag line at the end) or removes them from its text. Tags are lowercased and nest with /, like clients/acme.",
      inputSchema: { id: z.uuid(), add: z.array(z.string().max(100)).max(20).optional(), remove: z.array(z.string().max(100)).max(20).optional(), provenanceUrl },
    },
    async (args) =>
      run(async () => {
        const result = await editDoc(actor, args.id, { action: "tag", add: args.add, remove: args.remove }, provenance("tag_doc", args.provenanceUrl));
        return { doc: summary(result.doc) };
      }),
  );

  server.registerTool(
    "share_doc",
    {
      description: "Shares a doc with the whole workspace (every member can read and edit it), or with shared false makes it private again. Only the owner can make a doc private; daily notes can't be shared.",
      inputSchema: { id: z.uuid(), shared: z.boolean(), provenanceUrl },
    },
    async (args) =>
      run(async () => {
        const result = await shareDoc(actor, args.id, args.shared, provenance("share_doc", args.provenanceUrl));
        return { doc: summary(result.doc), visibility: result.visibility };
      }),
  );

  server.registerTool(
    "archive_doc",
    {
      description: "Archives a doc, or with restore true brings an archived one back. Nothing is deleted.",
      inputSchema: { id: z.uuid(), restore: z.boolean().optional(), provenanceUrl },
    },
    async (args) =>
      run(async () => ({
        doc: summary(args.restore ? await restoreDoc(actor, args.id, provenance("restore_doc", args.provenanceUrl)) : await archiveDoc(actor, args.id, provenance("archive_doc", args.provenanceUrl))),
      })),
  );

  server.registerTool(
    "list_doc_versions",
    {
      description: "A doc's saved versions, newest first: when, who (a person, the Orbit assistant or an agent) and what changed.",
      inputSchema: { id: z.uuid(), limit: z.number().int().min(1).max(500).optional() },
    },
    async (args) => run(async () => ({ versions: await listVersions(actor, args.id, args.limit) })),
  );

  server.registerTool(
    "restore_doc_version",
    {
      description: "Restores a doc to one of its versions. The current text is kept as a version first, so this can be undone.",
      inputSchema: { id: z.uuid(), version_id: z.uuid(), provenanceUrl },
    },
    async (args) => run(async () => ({ doc: summary(await restoreVersion(actor, args.id, args.version_id, provenance("restore_doc_version", args.provenanceUrl))) })),
  );

  if (!personal) return;

  server.registerTool(
    "get_daily_note",
    {
      description:
        "This person's private daily note for a day (today by default, or YYYY-MM-DD), created if it doesn't exist yet. Entries start with the time, like 09:15 Call with Priya. meetings true adds the day's meetings from their calendar. With list true, lists the days that have notes instead.",
      inputSchema: {
        date: z.string().max(20).optional(),
        meetings: z.boolean().optional(),
        list: z.boolean().optional(),
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
      },
    },
    async (args) =>
      run(async () => {
        if (args.list) return { days: await listDailyNotes(actor, { from: args.from, to: args.to }) };
        const note = await openDailyNote(actor, args.date, { meetings: args.meetings });
        return { date: note.date, isToday: note.isToday, doc: detail(note.page), text: note.page.content, meetings: note.meetings };
      }),
  );

  server.registerTool(
    "append_daily_note",
    {
      description: "Adds a timed entry to this person's private daily note (today by default). meetings true adds a line with the day's meetings.",
      inputSchema: { text: z.string().max(20_000).optional(), date: z.string().max(20).optional(), meetings: z.boolean().optional() },
    },
    async (args) =>
      run(async () => {
        const note = await appendToDailyNote(actor, { text: args.text, date: args.date, meetings: args.meetings }, provenance("append_daily_note"));
        return { date: note.date, doc: summary(note.page), text: note.page.content };
      }),
  );
}
