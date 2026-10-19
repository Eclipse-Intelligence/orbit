import { BODY_HTML_MAX, htmlToText } from "@/lib/mail/text";
import { MailSyncReset, type DeltaPage, type MailAddress, type MailRole, type ProviderFolder, type ProviderMessage } from "@/lib/mail/types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 50;
const FOLDER_LIMIT = 300;
const FOLDER_DEPTH = 5;
const FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount";
const MESSAGE_FIELDS = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "bodyPreview",
  "body",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "sentDateTime",
  "receivedDateTime",
  "isRead",
  "isDraft",
  "flag",
  "importance",
  "hasAttachments",
  "categories",
  "webLink",
].join(",");

const WELL_KNOWN: [string, MailRole][] = [
  ["inbox", "inbox"],
  ["sentitems", "sent"],
  ["drafts", "drafts"],
  ["archive", "archive"],
  ["deleteditems", "trash"],
  ["junkemail", "junk"],
  ["outbox", "outbox"],
];

type GraphFolder = {
  id: string;
  displayName?: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
};

type GraphRecipient = { emailAddress?: { name?: string | null; address?: string | null } | null };

type GraphMessage = {
  id: string;
  "@removed"?: { reason?: string };
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string | null } | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  bccRecipients?: GraphRecipient[] | null;
  sentDateTime?: string | null;
  receivedDateTime?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string } | null;
  importance?: string | null;
  hasAttachments?: boolean;
  categories?: string[] | null;
  webLink?: string | null;
};

export class GraphMailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function graphUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "graph.microsoft.com") {
    throw new GraphMailError("Microsoft returned an unexpected link.", 502);
  }
  return parsed.toString();
}

async function graphJson<T>(url: string, token: string, fetchImpl: typeof fetch, prefer?: string): Promise<T> {
  const response = await fetchImpl(graphUrl(url), {
    headers: {
      authorization: `Bearer ${token}`,
      prefer: [prefer, 'IdType="ImmutableId"'].filter(Boolean).join(", "),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? "";
  if (response.status === 410 || /syncstate/i.test(code)) throw new MailSyncReset(body.error?.message ?? "The sync state expired.");
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    throw new GraphMailError("Microsoft rejected the mailbox connection. Connect it again.", 401);
  }
  if (response.status === 403) throw new GraphMailError("Microsoft hasn't allowed Orbit to read this mailbox. Connect it again.", 403);
  throw new GraphMailError((body.error?.message || `Microsoft answered ${response.status}.`).slice(0, 240), response.status);
}

function address(value: GraphRecipient | null | undefined): MailAddress | null {
  const raw = value?.emailAddress?.address?.trim().toLowerCase();
  if (!raw) return null;
  return { name: value?.emailAddress?.name?.trim() || null, address: raw.slice(0, 320) };
}

function addresses(values: GraphRecipient[] | null | undefined) {
  return (values ?? []).map(address).filter((item): item is MailAddress => item !== null).slice(0, 200);
}

export function normaliseMessage(message: GraphMessage): ProviderMessage {
  const html = message.body?.contentType?.toLowerCase() === "html" ? (message.body.content ?? "") : null;
  const plain = html === null ? (message.body?.content ?? "") : null;
  const truncated = html !== null && html.length > BODY_HTML_MAX;
  return {
    providerId: message.id,
    partial: !("receivedDateTime" in message) && !("subject" in message),
    internetMessageId: message.internetMessageId?.slice(0, 1000) ?? null,
    threadKey: message.conversationId?.slice(0, 400) ?? null,
    subject: message.subject?.slice(0, 2000) ?? null,
    snippet: message.bodyPreview?.replace(/\s+/g, " ").trim().slice(0, 500) || null,
    bodyHtml: html !== null && !truncated ? html : null,
    bodyText: html !== null ? htmlToText(html) : plain ? plain.slice(0, 200_000) : null,
    bodyTruncated: truncated,
    from: address(message.from),
    to: addresses(message.toRecipients),
    cc: addresses(message.ccRecipients),
    bcc: addresses(message.bccRecipients),
    sentAt: message.sentDateTime ?? null,
    receivedAt: message.receivedDateTime ?? null,
    isRead: Boolean(message.isRead),
    isDraft: Boolean(message.isDraft),
    isFlagged: message.flag?.flagStatus === "flagged",
    importance: message.importance ?? null,
    hasAttachments: Boolean(message.hasAttachments),
    categories: (message.categories ?? []).slice(0, 50),
    webLink: message.webLink?.slice(0, 2000) ?? null,
  };
}

async function folderPages(url: string, token: string, fetchImpl: typeof fetch) {
  const folders: GraphFolder[] = [];
  let next: string | null = url;
  while (next && folders.length < FOLDER_LIMIT) {
    const page: { value?: GraphFolder[]; "@odata.nextLink"?: string } = await graphJson(next, token, fetchImpl);
    folders.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return folders;
}

export async function listMicrosoftFolders(token: string, fetchImpl: typeof fetch = fetch): Promise<ProviderFolder[]> {
  const roles = new Map<string, MailRole>();
  for (const [name, role] of WELL_KNOWN) {
    try {
      const found = await graphJson<{ id: string }>(`${GRAPH}/me/mailFolders/${name}?$select=id`, token, fetchImpl);
      roles.set(found.id, role);
    } catch (error) {
      if (error instanceof GraphMailError && error.status === 404) continue;
      throw error;
    }
  }
  const all: GraphFolder[] = [];
  let level = await folderPages(`${GRAPH}/me/mailFolders?$top=100&$select=${FOLDER_FIELDS}`, token, fetchImpl);
  for (let depth = 0; depth < FOLDER_DEPTH && level.length > 0 && all.length < FOLDER_LIMIT; depth += 1) {
    all.push(...level);
    const next: GraphFolder[] = [];
    for (const folder of level) {
      if (!folder.childFolderCount || all.length + next.length >= FOLDER_LIMIT) continue;
      next.push(
        ...(await folderPages(
          `${GRAPH}/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$top=100&$select=${FOLDER_FIELDS}`,
          token,
          fetchImpl,
        )),
      );
    }
    level = next;
  }
  return all.slice(0, FOLDER_LIMIT).map((folder) => ({
    providerId: folder.id,
    parentProviderId: folder.parentFolderId ?? null,
    name: (folder.displayName?.trim() || "Folder").slice(0, 300),
    role: roles.get(folder.id) ?? "other",
    total: folder.totalItemCount ?? 0,
    unread: folder.unreadItemCount ?? 0,
  }));
}

export function initialDeltaUrl(folderId: string) {
  return `${GRAPH}/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${MESSAGE_FIELDS}&$orderby=receivedDateTime%20desc`;
}

export async function fetchMicrosoftDelta(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<DeltaPage> {
  const page = await graphJson<{ value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(
    url,
    token,
    fetchImpl,
    `odata.maxpagesize=${PAGE_SIZE}, outlook.body-content-type="html"`,
  );
  const messages: ProviderMessage[] = [];
  const removed: string[] = [];
  for (const item of page.value ?? []) {
    if (!item.id) continue;
    if (item["@removed"]) removed.push(item.id);
    else messages.push(normaliseMessage(item));
  }
  return {
    messages,
    removed,
    nextLink: page["@odata.nextLink"] ? graphUrl(page["@odata.nextLink"]) : null,
    deltaLink: page["@odata.deltaLink"] ? graphUrl(page["@odata.deltaLink"]) : null,
  };
}
