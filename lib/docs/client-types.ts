import type { MentionKind } from "@/lib/mentions";

export type Visibility = "private" | "shared";

export type ParticipantKind = "person" | "assistant" | "mcp";

export type Participant = {
  id: string;
  name: string;
  short: string;
  initials: string;
  color: string;
  kind: ParticipantKind;
};

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  visibility: Visibility;
  shared: boolean;
  owner: Participant;
  noteCount: number;
};

export type TagNode = {
  name: string;
  path: string;
  count: number;
  children: TagNode[];
};

export type PageKind = "note" | "daily";

export type PageSummary = {
  id: string;
  kind: PageKind;
  title: string;
  snippet: string;
  folderId: string | null;
  dailyDate: string | null;
  visibility: Visibility;
  shared: boolean;
  owner: Participant;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: Participant;
  wordCount: number;
  entryCount: number;
};

export type Page = PageSummary & {
  body: string;
  revision: number;
  assistantCanEdit: boolean;
  createdBy: Participant;
};

export type Presence = {
  participant: Participant;
  cursor: number | null;
  insertFrom?: number;
  writing?: boolean;
};

export type LinkContext = {
  pageId: string;
  title: string;
  kind: PageKind;
  dailyDate: string | null;
  folderName: string | null;
  shared: boolean;
  updatedAt: string;
  snippet: string;
  matchFrom: number;
  matchTo: number;
};

export type Backlinks = {
  linked: LinkContext[];
  unlinked: LinkContext[];
};

export type RecordRef = {
  kind: MentionKind;
  id: string;
  name: string;
  detail: string | null;
};

export type LinkTarget =
  | { kind: "note"; pageId: string; title: string; folderName: string | null; shared: boolean; updatedAt: string; updatedBy: Participant }
  | { kind: "heading"; pageId: string; title: string; heading: string }
  | { kind: "daily"; pageId: string; title: string; dailyDate: string; snippet: string };

export type Version = {
  id: string;
  pageId: string;
  createdAt: string;
  author: Participant;
  summary: string;
  askedBy: string | null;
  title: string;
  body: string;
};

export type DailySummary = {
  date: string;
  pageId: string;
  entries: number;
  preview: string;
};

export type Meeting = {
  id: string;
  title: string;
  start: string;
  href: string;
};

export type SearchHit = {
  page: PageSummary;
  snippet: string;
  matchFrom: number;
  matchTo: number;
};

export type SearchResults = {
  query: string;
  titles: PageSummary[];
  text: SearchHit[];
};

export type PageFilter =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "tag"; path: string }
  | { kind: "daily" }
  | { kind: "search"; query: string };

export type PageSort = "edited" | "created" | "title";

export type SaveInput = {
  title: string;
  body: string;
  baseRevision: number;
};

export type SaveResult = { ok: true; page: Page } | { ok: false; error: string; conflict?: Page };

export type CreateInput = {
  title?: string;
  folderId?: string | null;
  body?: string;
};

export type ShareTarget = { kind: "page" | "folder"; id: string };

export type DocsNav = {
  viewer: Participant;
  folders: Folder[];
  tags: TagNode[];
  dailyCount: number;
  today: string;
  todayNote: DailySummary | null;
};

export type DocsSeed = { now: string; viewer: { id: string; name: string } };

export type DocsSnapshot = DocsNav & {
  now: string;
  summaries: PageSummary[];
};

export type PresenceListener = (presence: Presence[]) => void;

export type ActivityListener = (activity: Record<string, Participant[]>) => void;

export interface DocsData {
  nav(): Promise<DocsNav>;
  listPages(filter: PageFilter, sort?: PageSort): Promise<PageSummary[]>;
  recent(limit?: number): Promise<PageSummary[]>;
  search(query: string): Promise<SearchResults>;
  getPage(id: string): Promise<Page | null>;
  savePage(id: string, input: SaveInput, options?: { keepalive?: boolean }): Promise<SaveResult>;
  createPage(input: CreateInput): Promise<Page>;
  renamePage(id: string, title: string): Promise<Page>;
  movePage(id: string, folderId: string | null): Promise<Page>;
  archivePage(id: string): Promise<void>;
  restorePage(id: string): Promise<Page>;
  setAssistantCanEdit(id: string, value: boolean): Promise<Page>;
  createFolder(name: string, parentId: string | null): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  moveFolder(id: string, parentId: string | null, position: number): Promise<Folder[]>;
  share(target: ShareTarget, visibility: Visibility): Promise<void>;
  listVersions(pageId: string): Promise<Version[]>;
  restoreVersion(pageId: string, versionId: string): Promise<Page>;
  dailyNote(date: string): Promise<Page>;
  listDailyNotes(): Promise<DailySummary[]>;
  meetingsOn(date: string): Promise<Meeting[]>;
  backlinks(pageId: string): Promise<Backlinks>;
  linkTargets(query: string, fromPageId: string | null): Promise<LinkTarget[]>;
  resolveTitles(): Promise<Record<string, string>>;
  recordMentions(record: { kind: MentionKind; id: string; name?: string }): Promise<SearchHit[]>;
  searchRecords(query: string): Promise<RecordRef[]>;
  recordDetails(refs: { kind: MentionKind; id: string; name: string }[]): Promise<RecordRef[]>;
  watchPresence(pageId: string, listener: PresenceListener): () => void;
  watchActivity(listener: ActivityListener): () => void;
}
