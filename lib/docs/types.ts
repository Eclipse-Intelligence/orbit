import type { MentionKind } from "@/lib/mentions";

export const DOC_TITLE_MAX = 300;
export const DOC_CONTENT_MAX = 1_000_000;
export const FOLDER_NAME_MAX = 200;
export const DOC_READ_WINDOW = 100_000;
export const DOC_TAG_MAX = 100;
export const PERSON_VERSION_EVERY_MS = 10 * 60_000;
export const VERSIONS_KEPT = 100;
export const VERSION_DAYS_KEPT = 365;

export const DOC_KINDS = ["note", "daily"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_EDITORS = ["person", "assistant", "agent"] as const;
export type DocEditor = (typeof DOC_EDITORS)[number];

export const DOC_VISIBILITIES = ["private", "shared", "shared_by_folder"] as const;
export type DocVisibility = (typeof DOC_VISIBILITIES)[number];

export const DOC_SORTS = ["edited", "created", "title"] as const;
export type DocSort = (typeof DOC_SORTS)[number];

export const VERSION_REASONS = ["created", "edited", "renamed", "before_agent", "restored", "link_renamed"] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

export const DOC_LINK_KINDS = ["page", "contact", "company", "task", "opportunity", "proposal"] as const;
export type DocLinkKind = (typeof DOC_LINK_KINDS)[number];

export type DocPerson = { id: string; name: string };

export type DocEditorRef = {
  editor: DocEditor;
  name: string;
  userId: string | null;
  personName: string | null;
  agentId: string | null;
};

export type DocFolder = {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  owner: DocPerson | null;
  ownedByMe: boolean;
  shared: boolean;
  effectiveShared: boolean;
  visibility: DocVisibility;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type DocSummary = {
  id: string;
  kind: DocKind;
  title: string;
  dailyDate: string | null;
  folderId: string | null;
  owner: DocPerson | null;
  ownedByMe: boolean;
  shared: boolean;
  effectiveShared: boolean;
  visibility: DocVisibility;
  assistantCanEdit: boolean;
  excerpt: string;
  tags: string[];
  wordCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  editedAt: string;
  lastEditor: DocEditorRef | null;
  archivedAt: string | null;
};

export type DocLink = {
  title: string;
  heading: string | null;
  pageId: string | null;
  pageTitle: string | null;
  archived: boolean;
};

export type DocMention = { kind: MentionKind; id: string; name: string };

export type DocReference = {
  id: string;
  kind: DocKind;
  title: string;
  dailyDate: string | null;
  folderId: string | null;
  folderName: string | null;
  visibility: DocVisibility;
  ownedByMe: boolean;
  editedAt: string;
  snippet: string;
};

export type DocDetail = DocSummary & {
  content: string;
  path: { id: string; name: string }[];
  links: DocLink[];
  mentions: DocMention[];
  canChangeSharing: boolean;
  canChangeAssistantEdit: boolean;
};

export type DocSearchHit = {
  id: string;
  kind: DocKind;
  title: string;
  dailyDate: string | null;
  folderId: string | null;
  visibility: DocVisibility;
  ownedByMe: boolean;
  editedAt: string;
  titleMatch: "exact" | "prefix" | "contains" | "fuzzy" | null;
  snippet: string | null;
  score: number;
};

export type DocTag = { tag: string; count: number };

export type DocVersion = {
  id: string;
  pageId: string;
  createdAt: string;
  reason: VersionReason;
  by: DocEditorRef;
  title: string;
  summary: string | null;
  wordCount: number;
};

export type DocVersionDetail = DocVersion & { content: string };

export type VisibilityChange = { before: DocVisibility; after: DocVisibility; changed: boolean };

export type DocMoveResult = { page: DocSummary; visibility: VisibilityChange };

export type FolderMoveResult = { folder: DocFolder; visibility: VisibilityChange };

export type FolderSharing = {
  folderId: string;
  shared: boolean;
  effectiveShared: boolean;
  docs: number;
  folders: number;
  sharedOnTheirOwn: number;
  ownedByOthers: number;
};

export type DocDiffLine = { kind: "same" | "add" | "remove" | "gap"; text: string };

export type DailyEntry = { time: string; text: string };

export type DailyMeeting = {
  id: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  joinUrl: string | null;
  webLink: string | null;
};

export type DailyNoteDay = { id: string; date: string; entryCount: number; excerpt: string; editedAt: string };

export type DailyNote = { page: DocDetail; date: string; isToday: boolean; meetings: DailyMeeting[] | null };

export type DocSaveInput = {
  title?: string;
  content?: string;
  baseRevision?: number;
  ydoc?: Uint8Array | null;
};

export type DocCreateInput = {
  title?: string;
  content?: string;
  folderId?: string | null;
  shared?: boolean;
};

export type DocListQuery = {
  folderId?: string | null;
  tag?: string;
  sort?: DocSort;
  archived?: boolean;
  limit?: number;
  offset?: number;
};

export const DOC_EDIT_ACTIONS = ["replace", "append", "edit", "tag"] as const;
export type DocEditAction = (typeof DOC_EDIT_ACTIONS)[number];

export type DocEdit =
  | { action: "replace"; content: string }
  | { action: "append"; content: string }
  | { action: "edit"; find: string; replace: string; all?: boolean }
  | { action: "tag"; add?: string[]; remove?: string[] };

export function docHref(id: string) {
  return `/docs/${id}`;
}

export function dailyHref(date: string) {
  return `/docs/daily/${date}`;
}
