import type {
  ActivityListener,
  Backlinks,
  CreateInput,
  DailySummary,
  DocsData,
  DocsNav,
  DocsSnapshot,
  Folder,
  LinkContext,
  LinkTarget,
  Meeting,
  Page,
  PageFilter,
  PageSort,
  PageSummary,
  Participant,
  Presence,
  PresenceListener,
  RecordRef,
  SaveInput,
  SaveResult,
  SearchHit,
  SearchResults,
  ShareTarget,
  Version,
  Visibility,
} from "@/lib/docs/client-types";
import { DocsError } from "@/lib/docs/client-types";
import { shiftDate as addDays, localDate as londonDay } from "@/lib/docs/daily";
import { wordDiff, type DiffPart } from "@/lib/docs/diff";
import { shortDay } from "@/lib/docs/format";
import {
  entryCount,
  excerptFrom,
  headingsIn,
  parseLinks,
  parseMentions,
  parseTags as tagsIn,
  plainText,
  rewriteLinkTitle,
  tagPrefixCounts,
  tagTree,
  wordCount,
} from "@/lib/docs/markdown";
import { DAILY_BODIES, DAILY_FILLER, DAILY_OFFSETS, Q4_ID, SAMPLE_FOLDERS, SAMPLE_NOTES, SAMPLE_PEOPLE, SAMPLE_RECORDS, type SampleAuthor } from "./docs-sample";
import type { MentionKind } from "@/lib/mentions";
import { viewerParticipant } from "@/lib/docs/participants";

function snippetOf(body: string, max = 200) {
  return excerptFrom(body.replace(/^\d{2}:\d{2}( |$)/gm, ""), max);
}

function changeSummary(parts: DiffPart[]) {
  const count = (type: DiffPart["type"]) => parts.filter((part) => part.type === type).reduce((sum, part) => sum + (part.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  return { added: count("add"), removed: count("del") };
}

function tagMatches(tags: string[], path: string) {
  const wanted = path.trim().replace(/^#+/, "").toLowerCase();
  return tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
}

function findWikiLinks(body: string) {
  return parseLinks(body).map((link) => ({ target: link.title || link.target, heading: link.heading, label: link.label }));
}

function unlinkedMatches(body: string, title: string) {
  const clean = title.trim();
  if (clean.length < 3) return [];
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}[])(${escaped})(?![\\p{L}\\p{N}\\]])`, "giu");
  const linked = parseLinks(body);
  return [...body.matchAll(pattern)]
    .map((match) => ({ from: (match.index ?? 0) + match[1].length, to: (match.index ?? 0) + match[1].length + match[2].length }))
    .filter((range) => !linked.some((link) => range.from >= link.start && range.to <= link.end));
}

function contextAround(text: string, from: number, to: number, radius = 90) {
  const start = Math.max(0, from - radius);
  const end = Math.min(text.length, to + radius);
  const prefix = start > 0 ? "…" : "";
  return { text: `${prefix}${text.slice(start, end)}${end < text.length ? "…" : ""}`, matchFrom: prefix.length + from - start, matchTo: prefix.length + to - start };
}

type StoredVersion = Version & { body: string };

type Row = {
  id: string;
  kind: "note" | "daily";
  title: string;
  body: string;
  folderId: string | null;
  dailyDate: string | null;
  visibility: Visibility;
  owner: Participant;
  createdBy: Participant;
  createdAt: string;
  updatedAt: string;
  updatedBy: Participant;
  revision: number;
  assistantCanEdit: boolean;
  archived: boolean;
};

type FolderRow = { id: string; name: string; parentId: string | null; position: number; visibility: Visibility; owner: Participant };

export type FakeOptions = {
  now: string;
  viewer: { id: string; name: string };
  recordSearch?: (query: string) => Promise<RecordRef[]>;
  longNote?: boolean;
};

const VERSION_GAP_MS = 10 * 60_000;
const LONG_NOTE_ID = "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0e01";

function words(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function longBody() {
  const paragraphs: string[] = ["Every call since January, newest at the bottom. #archive"];
  for (let index = 1; index <= 1500; index += 1) {
    if (index % 25 === 1) paragraphs.push(`## Week ${Math.ceil(index / 25)}`);
    paragraphs.push(
      `- **Call ${index}** with a partner lead about the pilot. They asked about pricing, onboarding and the renewal date, and wanted to know how [[Partner tiers and margins]] apply to resellers.`,
    );
  }
  return paragraphs.join("\n\n");
}

export function createFakeDocs(options: FakeOptions): DocsData & { snapshot(limit?: number): DocsSnapshot } {
  const anchor = new Date(options.now).getTime();
  const viewer = viewerParticipant(options.viewer);
  const people: Record<SampleAuthor, Participant> = { viewer, ...SAMPLE_PEOPLE };
  const ago = (minutes: number) => new Date(anchor - Math.round(minutes * 60_000)).toISOString();
  const nowIso = () => new Date(Math.max(Date.now(), anchor)).toISOString();
  const today = londonDay(new Date(options.now));

  const folders = new Map<string, FolderRow>(
    SAMPLE_FOLDERS.map((folder, position) => [folder.id, { id: folder.id, name: folder.name, parentId: folder.parentId, position, visibility: folder.visibility, owner: people[folder.owner] }]),
  );
  const rows = new Map<string, Row>();
  const versions = new Map<string, StoredVersion[]>();
  const summaryCache = new Map<string, { key: string; value: PageSummary }>();
  const presenceListeners = new Map<string, Set<PresenceListener>>();
  const activityListeners = new Set<ActivityListener>();
  let counter = 0;

  for (const note of SAMPLE_NOTES) {
    const owner = people[note.author];
    rows.set(note.id, {
      id: note.id,
      kind: "note",
      title: note.title,
      body: note.body,
      folderId: note.folderId,
      dailyDate: null,
      visibility: note.visibility ?? "private",
      owner,
      createdBy: owner,
      createdAt: ago(note.createdMinutesAgo),
      updatedAt: ago(note.editedMinutesAgo),
      updatedBy: people[note.editedBy ?? note.author],
      revision: 1,
      assistantCanEdit: false,
      archived: false,
    });
  }
  if (options.longNote !== false) {
    rows.set(LONG_NOTE_ID, {
      id: LONG_NOTE_ID,
      kind: "note",
      title: "Call notes archive",
      body: longBody(),
      folderId: "f-ideas",
      dailyDate: null,
      visibility: "private",
      owner: viewer,
      createdBy: viewer,
      createdAt: ago(300 * 24 * 60),
      updatedAt: ago(45 * 24 * 60),
      updatedBy: viewer,
      revision: 1,
      assistantCanEdit: false,
      archived: false,
    });
  }
  DAILY_OFFSETS.forEach((offset, index) => {
    const date = addDays(today, -offset);
    const body = DAILY_BODIES[offset] ?? `09:${String(10 + (index % 40)).padStart(2, "0")} ${DAILY_FILLER[index % DAILY_FILLER.length]}`;
    const id = `daily-${date}`;
    rows.set(id, {
      id,
      kind: "daily",
      title: shortDay(date),
      body,
      folderId: null,
      dailyDate: date,
      visibility: "private",
      owner: viewer,
      createdBy: viewer,
      createdAt: ago(offset * 24 * 60 + 60),
      updatedAt: offset === 0 ? ago(20) : ago(offset * 24 * 60 - 8 * 60),
      updatedBy: viewer,
      revision: 1,
      assistantCanEdit: false,
      archived: false,
    });
  });

  const q4 = rows.get(Q4_ID);
  if (q4) {
    const versionsBody = q4.body;
    const before = versionsBody
      .replace("Acme's renewal lands in January, so the pilot results need to be in their hands by 12 December, with the case study\n\n", "Acme's renewal could matter by early December.\n\n")
      .replace("- [x] Share revised pricing", "- [ ] Share revised pricing");
    const older = before.replace(/\n\n## Numbers to watch[\s\S]*$/, "");
    const first = older.replace(/\n\n## Q4 plan[\s\S]*$/, "");
    const make = (minutes: number, author: Participant, summary: string, body: string, askedBy: string | null = null): StoredVersion => ({
      id: `v-${minutes}-${author.id}`,
      pageId: Q4_ID,
      createdAt: ago(minutes),
      author,
      summary,
      askedBy,
      title: q4.title,
      body,
    });
    versions.set(Q4_ID, [
      make(1, SAMPLE_PEOPLE.priya, `Editing with ${viewer.short}`, versionsBody),
      make(62, SAMPLE_PEOPLE.assistant, "Added a risk on the Acme renewal, ticked 1 task", versionsBody, `Asked by ${viewer.short}`),
      make(84, viewer, "Rewrote Where we are", before),
      make(221, SAMPLE_PEOPLE.claude, "Updated pipeline figures from Orbit", older, `${viewer.short}'s MCP token`),
      make(24 * 60 + 60, SAMPLE_PEOPLE.priya, "Added Northwind risk", older),
      make(24 * 60 + 166, viewer, "Added Q4 plan", older),
      make(15 * 24 * 60, viewer, "Created", first),
    ]);
  }

  function folderShared(folderId: string | null): boolean {
    let current = folderId ? folders.get(folderId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.visibility === "shared") return true;
      seen.add(current.id);
      current = current.parentId ? folders.get(current.parentId) : undefined;
    }
    return false;
  }

  function summary(row: Row): PageSummary {
    const shared = row.kind === "note" && (row.visibility === "shared" || folderShared(row.folderId));
    const key = `${row.id}:${row.revision}:${row.title}:${row.folderId}:${row.visibility}:${shared}:${row.updatedAt}`;
    const cached = summaryCache.get(row.id);
    if (cached?.key === key) return cached.value;
    const value: PageSummary = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      snippet: snippetOf(row.body),
      folderId: row.folderId,
      dailyDate: row.dailyDate,
      visibility: row.visibility,
      shared,
      owner: row.owner,
      tags: tagsIn(row.body),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      wordCount: wordCount(row.body),
      entryCount: entryCount(row.body),
    };
    summaryCache.set(row.id, { key, value });
    return value;
  }

  function page(row: Row): Page {
    return { ...summary(row), body: row.body, revision: row.revision, assistantCanEdit: row.assistantCanEdit, createdBy: row.createdBy };
  }

  function live() {
    return [...rows.values()].filter((row) => !row.archived);
  }

  function notes() {
    return live().filter((row) => row.kind === "note");
  }

  function folderList(): Folder[] {
    const counts = new Map<string, number>();
    for (const row of notes()) if (row.folderId) counts.set(row.folderId, (counts.get(row.folderId) ?? 0) + 1);
    return [...folders.values()]
      .sort((left, right) => left.position - right.position)
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        position: folder.position,
        visibility: folder.visibility,
        shared: folderShared(folder.id),
        owner: folder.owner,
        noteCount: counts.get(folder.id) ?? 0,
      }));
  }

  function descendants(folderId: string) {
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of folders.values()) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  function sortRows(list: Row[], sort: PageSort) {
    if (sort === "title") return list.sort((left, right) => (left.title || "Untitled").localeCompare(right.title || "Untitled"));
    if (sort === "created") return list.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function titleHits(query: string) {
    const wanted = words(query);
    return notes().filter((row) => {
      const title = row.title.toLowerCase();
      return wanted.every((word) => title.includes(word));
    });
  }

  function textHits(query: string, exclude: Set<string>): SearchHit[] {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return [];
    const hits: SearchHit[] = [];
    for (const row of live()) {
      if (exclude.has(row.id)) continue;
      const text = plainText(row.body);
      const index = text.toLowerCase().indexOf(wanted);
      if (index < 0) continue;
      const context = contextAround(text, index, index + wanted.length);
      hits.push({ page: summary(row), snippet: context.text, matchFrom: context.matchFrom, matchTo: context.matchTo });
    }
    return hits.sort((left, right) => right.page.updatedAt.localeCompare(left.page.updatedAt));
  }

  function linkContext(row: Row, label: string): LinkContext | null {
    const lines = row.body.split("\n");
    for (const line of lines) {
      const plain = plainText(line).trim();
      const index = plain.toLowerCase().indexOf(label.toLowerCase());
      if (index < 0) continue;
      const context = contextAround(plain, index, index + label.length, 70);
      const folder = row.folderId ? folders.get(row.folderId) : undefined;
      return {
        pageId: row.id,
        title: row.title,
        kind: row.kind,
        dailyDate: row.dailyDate,
        folderName: folder?.name ?? null,
        shared: summary(row).shared,
        updatedAt: row.updatedAt,
        snippet: context.text,
        matchFrom: context.matchFrom,
        matchTo: context.matchTo,
      };
    }
    return null;
  }

  function nextId(prefix: string) {
    counter += 1;
    return `${prefix}-${anchor.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function require(id: string) {
    const row = rows.get(id);
    if (!row) throw new Error("That note no longer exists.");
    return row;
  }

  function touch(row: Row, by: Participant = viewer) {
    row.revision += 1;
    row.updatedAt = nowIso();
    row.updatedBy = by;
  }

  function recordVersion(row: Row, author: Participant) {
    const list = versions.get(row.id) ?? [];
    const latest = list[0];
    const previous = latest?.body ?? "";
    const { added, removed } = changeSummary(wordDiff(previous, row.body));
    const summaryText = !latest ? "Created" : added && !removed ? `Added ${added} ${added === 1 ? "word" : "words"}` : removed && !added ? `Removed ${removed} ${removed === 1 ? "word" : "words"}` : "Edited";
    const fresh = !latest || latest.author.id !== author.id || Date.parse(row.updatedAt) - Date.parse(latest.createdAt) > VERSION_GAP_MS;
    if (fresh) {
      list.unshift({ id: nextId("v"), pageId: row.id, createdAt: row.updatedAt, author, summary: summaryText, askedBy: null, title: row.title, body: row.body });
    } else {
      list[0] = { ...latest, createdAt: row.updatedAt, body: row.body, title: row.title };
    }
    versions.set(row.id, list);
  }

  function emitActivity() {
    const activity: Record<string, Participant[]> = q4 && !q4.archived ? { [Q4_ID]: [SAMPLE_PEOPLE.assistant, SAMPLE_PEOPLE.priya] } : {};
    for (const listener of activityListeners) listener(activity);
  }

  function presenceFor(pageId: string): Presence[] {
    if (pageId !== Q4_ID || !q4) return [];
    const body = q4.body;
    const sentence = "Acme's renewal lands in January";
    const sentenceAt = body.indexOf(sentence);
    const writingEnd = body.indexOf("with the case study", sentenceAt);
    const chase = body.indexOf("Priya owns the chase.");
    const presence: Presence[] = [];
    if (sentenceAt >= 0 && writingEnd >= 0) {
      presence.push({ participant: SAMPLE_PEOPLE.assistant, cursor: writingEnd + "with the case study".length, insertFrom: sentenceAt, writing: true });
    }
    if (chase >= 0) presence.push({ participant: SAMPLE_PEOPLE.priya, cursor: chase + "Priya owns the chase.".length });
    return presence;
  }

  const records = Object.values(SAMPLE_RECORDS) as RecordRef[];

  function navSync(): DocsNav {
    const dailies = live().filter((row) => row.kind === "daily" && row.body.trim());
    const todayRow = rows.get(`daily-${today}`);
    return {
      viewer,
      folders: folderList(),
      tags: tagTree(tagPrefixCounts(notes().map((row) => tagsIn(row.body)))),
      dailyCount: dailies.length,
      today,
      todayNote: todayRow && !todayRow.archived ? { date: today, pageId: todayRow.id, entries: entryCount(todayRow.body), preview: snippetOf(todayRow.body, 120) } : null,
    };
  }

  function listSync(filter: PageFilter, sort: PageSort = "edited"): PageSummary[] {
    if (filter.kind === "daily") {
      return live()
        .filter((row) => row.kind === "daily")
        .sort((left, right) => (right.dailyDate ?? "").localeCompare(left.dailyDate ?? ""))
        .map(summary);
    }
    if (filter.kind === "search") {
      const titles = titleHits(filter.query);
      const exclude = new Set(titles.map((row) => row.id));
      return [...sortRows(titles, sort).map(summary), ...textHits(filter.query, exclude).map((hit) => hit.page)];
    }
    let list = notes();
    if (filter.kind === "folder") {
      const ids = descendants(filter.folderId);
      list = list.filter((row) => row.folderId !== null && ids.has(row.folderId));
    }
    if (filter.kind === "tag") list = list.filter((row) => tagMatches(tagsIn(row.body), filter.path));
    return sortRows(list, sort).map(summary);
  }

  const data: DocsData & { snapshot(limit?: number): DocsSnapshot } = {
    snapshot(limit = 200) {
      return { ...navSync(), now: options.now, summaries: listSync({ kind: "all" }).slice(0, limit) };
    },
    async nav() {
      return navSync();
    },
    async listPages(filter, sort = "edited") {
      return listSync(filter, sort);
    },
    async recent(limit = 6) {
      return sortRows(live(), "edited")
        .slice(0, limit)
        .map(summary);
    },
    async search(query): Promise<SearchResults> {
      const titles = sortRows(titleHits(query), "edited").map(summary);
      const exclude = new Set(titles.map((row) => row.id));
      return { query, titles, text: textHits(query, exclude) };
    },
    async getPage(id) {
      const row = rows.get(id);
      return row && !row.archived ? page(row) : null;
    },
    async savePage(id, saveInput: SaveInput): Promise<SaveResult> {
      const row = rows.get(id);
      const input = { ...saveInput, title: saveInput.title ?? row?.title ?? "" };
      if (!row || row.archived) return { ok: false, error: "That note was archived. Restore it to keep editing." };
      if (row.body === input.body && row.title === input.title) return { ok: true, page: page(row) };
      const renamed = row.kind === "note" && row.title.trim() && row.title !== input.title ? row.title : null;
      if (!versions.get(row.id)?.length) {
        versions.set(row.id, [{ id: nextId("v"), pageId: row.id, createdAt: row.createdAt, author: row.createdBy, summary: "Created", askedBy: null, title: row.title, body: row.body }]);
      }
      row.body = input.body;
      row.title = row.kind === "daily" ? row.title : input.title;
      touch(row);
      recordVersion(row, viewer);
      if (renamed && input.title.trim()) {
        for (const other of rows.values()) {
          if (other.id === row.id) continue;
          const next = rewriteLinkTitle(other.body, renamed, input.title.trim()).content;
          if (next !== other.body) {
            other.body = next;
            other.revision += 1;
          }
        }
      }
      return { ok: true, page: page(row) };
    },
    async createPage(input: CreateInput) {
      const id = nextId("note");
      const at = nowIso();
      const row: Row = {
        id,
        kind: "note",
        title: input.title?.trim() ?? "",
        body: input.body ?? "",
        folderId: input.folderId ?? null,
        dailyDate: null,
        visibility: "private",
        owner: viewer,
        createdBy: viewer,
        createdAt: at,
        updatedAt: at,
        updatedBy: viewer,
        revision: 1,
        assistantCanEdit: false,
        archived: false,
      };
      rows.set(id, row);
      return page(row);
    },
    async renamePage(id, title) {
      const row = require(id);
      const result = await data.savePage(id, { title, body: row.body, baseRevision: row.revision });
      if (!result.ok) throw new Error(result.error);
      return result.page;
    },
    async movePage(id, folderId, moveOptions = {}) {
      const row = require(id);
      if (folderId && !folders.has(folderId)) throw new Error("That folder no longer exists.");
      const before = row.visibility === "shared" || folderShared(row.folderId);
      const after = row.visibility === "shared" || folderShared(folderId);
      if (before !== after && !moveOptions.allowVisibilityChange) {
        throw new DocsError(after ? "Moving it there shares it with the workspace." : "Moving it there makes it private.", "visibility_change", { after: after ? "shared" : "private" });
      }
      row.folderId = folderId;
      row.revision += 1;
      return page(row);
    },
    async archivePage(id) {
      const row = require(id);
      row.archived = true;
      emitActivity();
    },
    async restorePage(id) {
      const row = require(id);
      row.archived = false;
      emitActivity();
      return page(row);
    },
    async setAssistantCanEdit(id, value) {
      const row = require(id);
      row.assistantCanEdit = value;
      return page(row);
    },
    async createFolder(name, parentId) {
      const clean = name.trim();
      if (!clean) throw new Error("Give the folder a name.");
      const id = nextId("folder");
      const siblings = [...folders.values()].filter((folder) => folder.parentId === parentId);
      folders.set(id, { id, name: clean.slice(0, 120), parentId, position: siblings.length ? Math.max(...siblings.map((folder) => folder.position)) + 1 : 0, visibility: "private", owner: viewer });
      return folderList().find((folder) => folder.id === id) as Folder;
    },
    async renameFolder(id, name) {
      const folder = folders.get(id);
      if (!folder) throw new Error("That folder no longer exists.");
      if (!name.trim()) throw new Error("Give the folder a name.");
      folder.name = name.trim().slice(0, 120);
      return folderList().find((item) => item.id === id) as Folder;
    },
    async moveFolder(id, parentId, position) {
      const folder = folders.get(id);
      if (!folder) throw new Error("That folder no longer exists.");
      if (parentId && descendants(id).has(parentId)) throw new Error("A folder can't go inside itself.");
      const siblings = [...folders.values()]
        .filter((item) => item.parentId === parentId && item.id !== id)
        .sort((left, right) => left.position - right.position);
      siblings.splice(Math.max(0, Math.min(position, siblings.length)), 0, folder);
      folder.parentId = parentId;
      siblings.forEach((item, index) => {
        item.position = index;
      });
      return folderList();
    },
    async share(target: ShareTarget, visibility) {
      if (target.kind === "folder") {
        const folder = folders.get(target.id);
        if (!folder) throw new Error("That folder no longer exists.");
        if (folder.owner.id !== viewer.id) throw new Error(`Only ${folder.owner.name} can change who sees this folder.`);
        folder.visibility = visibility;
        return;
      }
      const row = require(target.id);
      if (row.kind === "daily") throw new Error("Daily notes are always private.");
      row.visibility = visibility;
      row.revision += 1;
    },
    async listVersions(pageId) {
      const list = versions.get(pageId);
      if (list?.length) return list;
      const row = rows.get(pageId);
      return row ? [{ id: `v-created-${row.id}`, pageId, createdAt: row.createdAt, author: row.createdBy, summary: "Created", askedBy: null, title: row.title, body: row.body }] : [];
    },
    async versionBody(pageId, versionId) {
      const version = (await data.listVersions(pageId)).find((item) => item.id === versionId) as StoredVersion | undefined;
      if (!version) throw new Error("That version is no longer available.");
      return { id: version.id, title: version.title, body: version.body };
    },
    async restoreVersion(pageId, versionId) {
      const row = require(pageId);
      const version = (await data.listVersions(pageId)).find((item) => item.id === versionId) as StoredVersion | undefined;
      if (!version) throw new Error("That version is no longer available.");
      row.body = version.body;
      if (row.kind === "note") row.title = version.title;
      touch(row);
      const list = versions.get(pageId) ?? [];
      list.unshift({ id: nextId("v"), pageId, createdAt: row.updatedAt, author: viewer, summary: "Restored an earlier version", askedBy: null, title: row.title, body: row.body });
      versions.set(pageId, list);
      return page(row);
    },
    async dailyNote(date) {
      const id = `daily-${date}`;
      let row = rows.get(id);
      if (!row) {
        const at = nowIso();
        row = {
          id,
          kind: "daily",
          title: shortDay(date),
          body: "",
          folderId: null,
          dailyDate: date,
          visibility: "private",
          owner: viewer,
          createdBy: viewer,
          createdAt: at,
          updatedAt: at,
          updatedBy: viewer,
          revision: 1,
          assistantCanEdit: false,
          archived: false,
        };
        rows.set(id, row);
      }
      row.archived = false;
      return page(row);
    },
    async listDailyNotes(): Promise<DailySummary[]> {
      return live()
        .filter((row) => row.kind === "daily" && row.dailyDate && row.body.trim())
        .sort((left, right) => (right.dailyDate ?? "").localeCompare(left.dailyDate ?? ""))
        .map((row) => ({ date: row.dailyDate as string, pageId: row.id, entries: entryCount(row.body), preview: snippetOf(row.body, 120) }));
    },
    async meetingsOn(date): Promise<Meeting[]> {
      if (date !== today) return [];
      return [
        { id: "m-acme", title: "Acme partner sync", start: `${date}T10:00:00Z`, href: "/calendar" },
        { id: "m-northwind", title: "Northwind legal", start: `${date}T14:00:00Z`, href: "/calendar" },
      ];
    },
    async backlinks(pageId): Promise<Backlinks> {
      const row = rows.get(pageId);
      if (!row) return { linked: [], unlinked: [] };
      const key = (row.kind === "daily" ? row.dailyDate ?? "" : row.title).toLowerCase();
      if (!key) return { linked: [], unlinked: [] };
      const linked: LinkContext[] = [];
      const unlinked: LinkContext[] = [];
      for (const other of live()) {
        if (other.id === pageId) continue;
        const link = findWikiLinks(other.body).find((item) => item.target.toLowerCase() === key);
        if (link) {
          const context = linkContext(other, link.label ?? (link.heading ? `${link.target} › ${link.heading}` : link.target));
          if (context) linked.push(context);
          continue;
        }
        if (row.kind === "note" && unlinkedMatches(other.body, row.title).length) {
          const context = linkContext(other, row.title);
          if (context) unlinked.push(context);
        }
      }
      const order = (left: LinkContext, right: LinkContext) => right.updatedAt.localeCompare(left.updatedAt);
      return { linked: linked.sort(order), unlinked: unlinked.sort(order) };
    },
    async linkTargets(query, fromPageId) {
      const wanted = words(query);
      const matches = (text: string) => wanted.every((word) => text.toLowerCase().includes(word));
      const noteRows = notes()
        .filter((row) => row.id !== fromPageId && row.title && matches(row.title))
        .sort((left, right) => {
          const leftStarts = left.title.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
          const rightStarts = right.title.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
          return leftStarts - rightStarts || right.updatedAt.localeCompare(left.updatedAt);
        })
        .slice(0, wanted.length ? 5 : 6);
      const targets: LinkTarget[] = noteRows.map((row) => ({
        kind: "note",
        pageId: row.id,
        title: row.title,
        folderName: row.folderId ? folders.get(row.folderId)?.name ?? null : null,
        shared: summary(row).shared,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      }));
      if (!wanted.length) return targets;
      const headingWords = wanted.filter((word) => word.length > 2);
      const headings: LinkTarget[] = [];
      for (const row of notes()) {
        if (row.id === fromPageId || headings.length >= 2) continue;
        for (const heading of headingsIn(row.body)) {
          if (headings.length >= 2) break;
          if (headingWords.some((word) => heading.text.toLowerCase().includes(word))) headings.push({ kind: "heading", pageId: row.id, title: row.title, heading: heading.text });
        }
      }
      const dailies: LinkTarget[] = [];
      for (const row of sortRows(live().filter((item) => item.kind === "daily"), "edited")) {
        if (dailies.length >= 1 || row.id === fromPageId) continue;
        const text = plainText(row.body);
        const lower = text.toLowerCase();
        const index = lower.indexOf(wanted.join(" "));
        const first = index >= 0 ? index : lower.indexOf(wanted[0]);
        if (first < 0 || !matches(text)) continue;
        const context = contextAround(text, first, first + wanted[0].length, 40);
        dailies.push({ kind: "daily", pageId: row.id, title: shortDay(row.dailyDate as string), dailyDate: row.dailyDate as string, snippet: context.text.replace(/^\d{2}:\d{2}\s+/, "") });
      }
      return [...targets, ...headings, ...dailies];
    },
    async resolveTitles() {
      const map: Record<string, string> = {};
      for (const row of live()) {
        if (row.kind === "daily" && row.dailyDate) map[row.dailyDate] = row.id;
        else if (row.title) map[row.title.toLowerCase()] = row.id;
      }
      return map;
    },
    async recordMentions(record) {
      const name = record.name?.trim().toLowerCase() ?? "";
      const hits: SearchHit[] = [];
      for (const row of live()) {
        const mention = parseMentions(row.body).find((item) => (item.kind === record.kind && item.id === record.id) || (name && item.kind === record.kind && item.name.toLowerCase() === name));
        if (!mention) continue;
        const context = linkContext(row, mention.name);
        hits.push({ page: summary(row), snippet: context?.snippet ?? summary(row).snippet, matchFrom: context?.matchFrom ?? 0, matchTo: context?.matchTo ?? 0 });
      }
      return hits.sort((left, right) => right.page.updatedAt.localeCompare(left.page.updatedAt));
    },
    async searchRecords(query) {
      const wanted = words(query);
      const local = records.filter((record) => wanted.every((word) => record.name.toLowerCase().includes(word)));
      const remote = options.recordSearch ? await options.recordSearch(query).catch(() => []) : [];
      const seen = new Set<string>();
      return [...remote, ...local].filter((record) => {
        const key = `${record.kind}:${record.name.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 8);
    },
    async recordDetails(refs: { kind: MentionKind; id: string; name: string }[]) {
      return refs.map((ref) => records.find((record) => record.id === ref.id) ?? { ...ref, detail: null });
    },
    watchPresence(pageId, listener) {
      const set = presenceListeners.get(pageId) ?? new Set<PresenceListener>();
      set.add(listener);
      presenceListeners.set(pageId, set);
      const timer = setTimeout(() => listener(presenceFor(pageId)), 0);
      return () => {
        clearTimeout(timer);
        set.delete(listener);
      };
    },
    watchActivity(listener) {
      activityListeners.add(listener);
      const timer = setTimeout(emitActivity, 0);
      return () => {
        clearTimeout(timer);
        activityListeners.delete(listener);
      };
    },
  };
  return data;
}
