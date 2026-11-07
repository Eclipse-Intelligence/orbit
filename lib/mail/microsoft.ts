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
  "inferenceClassification",
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
  inferenceClassification?: string | null;
};

export class GraphMailError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = "",
  ) {
    super(message);
  }
}

const SETTINGS = "Settings › Email";
const ADMIN_CONSENT = /AADSTS(50020|700016|65001|90094|50194|90008|500011)\b|consent_required|admin (approval|consent)|need admin|unauthorized_client/i;
const SIGNED_OUT = /invalid_grant|interaction_required|AADSTS(70008|50173|700082|50076|50079|50078|54005)\b|expired|revoked|rejected the mailbox connection/i;
const UNREADABLE = /could not read the saved Microsoft connection/i;

export function disconnectedMessage(email: string) {
  return `Reconnect ${email} in ${SETTINGS}. It isn't connected to Orbit any more.`;
}

export function reconnectProblem(error: unknown, email: string | null | undefined): string | null {
  const account = email?.trim() || "the mailbox";
  if (error instanceof GraphMailError) {
    if (error.status === 401) return `Reconnect ${account} in ${SETTINGS}. Microsoft has signed Orbit out of it.`;
    if (error.status !== 403) return null;
    if (ADMIN_CONSENT.test(error.code)) return `Ask your Microsoft admin to approve Orbit for ${account}, then reconnect it in ${SETTINGS}.`;
    return `Reconnect ${account} in ${SETTINGS} and allow every permission Microsoft asks for. Orbit doesn't have access to its mail.`;
  }
  if (!(error instanceof Error)) return null;
  const detail = `${"detail" in error && typeof error.detail === "string" ? error.detail : ""} ${error.message}`;
  if (ADMIN_CONSENT.test(detail)) return `Ask your Microsoft admin to approve Orbit for ${account}, then reconnect it in ${SETTINGS}.`;
  if (SIGNED_OUT.test(detail)) return `Reconnect ${account} in ${SETTINGS}. Microsoft has signed Orbit out of it.`;
  if (UNREADABLE.test(detail)) return `Reconnect ${account} in ${SETTINGS}. Orbit can't read its saved connection.`;
  return null;
}

const UNSURE_CODES = /^(UnknownError|ServiceUnavailable|GatewayTimeout|InternalServerError|ErrorInternalServerError|ErrorTimeoutExpired)$/i;

export function sendOutcomeUnknown(error: unknown) {
  if (!(error instanceof GraphMailError)) return true;
  if (error.status < 500) return false;
  return error.status !== 500 || !error.code || UNSURE_CODES.test(error.code);
}

const GRAPH_RETRIES = 2;
const RETRY_WAIT_MAX_MS = 5_000;

export function retryWaitMs(response: Pick<Response, "headers">, attempt: number) {
  const header = response.headers.get("retry-after");
  const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
  const wanted = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return wanted <= RETRY_WAIT_MAX_MS ? wanted : null;
}

function graphUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "graph.microsoft.com") {
    throw new GraphMailError("Microsoft returned an unexpected link.", 502);
  }
  return parsed.toString();
}

async function graphJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  prefer?: string,
  write?: { method: "PATCH" | "POST" | "DELETE"; body?: unknown },
): Promise<T> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetchImpl(graphUrl(url), {
      method: write?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        prefer: [prefer, 'IdType="ImmutableId"'].filter(Boolean).join(", "),
        ...(write ? { "content-type": "application/json" } : {}),
      },
      body: write && write.body !== undefined ? JSON.stringify(write.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const throttled = response.status === 429 || (response.status === 503 && !write);
    const wait = throttled && attempt < GRAPH_RETRIES ? retryWaitMs(response, attempt) : null;
    if (wait === null) break;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  if (response.ok) {
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? "";
  if (response.status === 410 || /syncstate/i.test(code)) throw new MailSyncReset(body.error?.message ?? "The sync state expired.");
  if (response.status === 401 || code === "InvalidAuthenticationToken") {
    throw new GraphMailError("Microsoft rejected the mailbox connection. Connect it again.", 401, code);
  }
  if (response.status === 403) {
    throw new GraphMailError(
      write ? "Microsoft hasn't allowed Orbit to change this mailbox. Connect it again." : "Microsoft hasn't allowed Orbit to read this mailbox. Connect it again.",
      403,
      `${code} ${body.error?.message ?? ""}`.trim(),
    );
  }
  throw new GraphMailError((body.error?.message || `Microsoft answered ${response.status}.`).slice(0, 240), response.status, code);
}

function address(value: GraphRecipient | null | undefined): MailAddress | null {
  const raw = value?.emailAddress?.address?.trim().toLowerCase();
  if (!raw) return null;
  return { name: value?.emailAddress?.name?.trim() || null, address: raw.slice(0, 320) };
}

function addresses(values: GraphRecipient[] | null | undefined) {
  return (values ?? []).map(address).filter((item): item is MailAddress => item !== null).slice(0, 200);
}

function focusedFrom(value: string | null | undefined) {
  if (value === "focused") return true;
  if (value === "other") return false;
  return null;
}

export async function fetchMicrosoftClassifications(url: string, token: string, fetchImpl: typeof fetch = fetch) {
  const page = await graphJson<{ value?: { id: string; inferenceClassification?: string | null }[]; "@odata.nextLink"?: string }>(url, token, fetchImpl);
  return {
    items: (page.value ?? []).flatMap((item) => {
      const focused = focusedFrom(item.inferenceClassification);
      return item.id && focused !== null ? [{ id: item.id, focused }] : [];
    }),
    next: page["@odata.nextLink"] ? graphUrl(page["@odata.nextLink"]) : null,
  };
}

export function classificationUrl(folderId: string) {
  return `${GRAPH}/me/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,inferenceClassification&$top=500`;
}

function normaliseMessage(message: GraphMessage): ProviderMessage {
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
    focused: focusedFrom(message.inferenceClassification),
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

export async function fetchMicrosoftMessageFolder(token: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  try {
    const found = await graphJson<{ parentFolderId?: string | null }>(
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=id,parentFolderId`,
      token,
      fetchImpl,
    );
    return typeof found.parentFolderId === "string" && found.parentFolderId ? found.parentFolderId : null;
  } catch (error) {
    if (error instanceof GraphMailError && error.status === 404) return null;
    throw error;
  }
}

type MicrosoftMessageChange = { isRead?: boolean; flagged?: boolean };

export async function updateMicrosoftMessage(token: string, messageId: string, change: MicrosoftMessageChange, fetchImpl: typeof fetch = fetch) {
  const body: Record<string, unknown> = {};
  if (change.isRead !== undefined) body.isRead = change.isRead;
  if (change.flagged !== undefined) body.flag = { flagStatus: change.flagged ? "flagged" : "notFlagged" };
  await graphJson<unknown>(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=id`, token, fetchImpl, undefined, { method: "PATCH", body });
}

export async function moveMicrosoftMessage(token: string, messageId: string, destination: string, fetchImpl: typeof fetch = fetch) {
  const moved = await graphJson<{ id?: string; parentFolderId?: string }>(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/move`,
    token,
    fetchImpl,
    undefined,
    { method: "POST", body: { destinationId: destination } },
  );
  return { id: moved.id ?? messageId, folderId: moved.parentFolderId ?? null };
}

export async function fetchMicrosoftHeaders(token: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  const message = await graphJson<{ internetMessageHeaders?: { name?: string; value?: string }[] | null }>(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=internetMessageHeaders`,
    token,
    fetchImpl,
  );
  return (message.internetMessageHeaders ?? []).flatMap((header) =>
    header.name && typeof header.value === "string" ? [{ name: header.name, value: header.value.slice(0, 4000) }] : [],
  );
}

export type ConversationMessage = { from: string | null; fromName: string | null; at: string | null; isDraft: boolean; internetMessageId: string | null };

export async function fetchConversationMessages(token: string, conversationId: string, fetchImpl: typeof fetch = fetch): Promise<ConversationMessage[]> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
  const page = await graphJson<{ value?: GraphMessage[] }>(
    `${GRAPH}/me/messages?$filter=${filter}&$select=id,from,receivedDateTime,sentDateTime,isDraft,internetMessageId&$top=50`,
    token,
    fetchImpl,
  );
  return (page.value ?? []).map((message) => ({
    from: message.from?.emailAddress?.address?.trim().toLowerCase() || null,
    fromName: message.from?.emailAddress?.name?.trim() || null,
    at: message.receivedDateTime ?? message.sentDateTime ?? null,
    isDraft: Boolean(message.isDraft),
    internetMessageId: message.internetMessageId ?? null,
  }));
}

export async function fetchInternetMessageId(token: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  const message = await graphJson<{ internetMessageId?: string | null }>(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=internetMessageId`,
    token,
    fetchImpl,
  );
  return message.internetMessageId?.slice(0, 1000) || null;
}

export type DraftState = "draft" | "sent" | "gone";

export async function fetchDraftState(token: string, draftId: string, fetchImpl: typeof fetch = fetch): Promise<DraftState> {
  try {
    const message = await graphJson<{ id?: string; isDraft?: boolean }>(`${GRAPH}/me/messages/${encodeURIComponent(draftId)}?$select=id,isDraft`, token, fetchImpl);
    if (!message.id || typeof message.isDraft !== "boolean") throw new GraphMailError("Outlook didn't say whether the draft is still there.", 502);
    return message.isDraft ? "draft" : "sent";
  } catch (error) {
    if (error instanceof GraphMailError && error.status === 404) return "gone";
    throw error;
  }
}

const SENT_LOOKBACK_MS = 60_000;

function sameSubject(left: string | null | undefined, right: string | null | undefined) {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return clean(left) === clean(right);
}

export async function findSentCopy(
  token: string,
  match: { internetMessageId: string | null; conversationId: string | null; subject: string | null; since: Date },
  fetchImpl: typeof fetch = fetch,
) {
  if (match.internetMessageId) {
    const filter = encodeURIComponent(`internetMessageId eq '${match.internetMessageId.replace(/'/g, "''")}'`);
    const page = await graphJson<{ value?: { id: string; isDraft?: boolean }[] }>(`${GRAPH}/me/messages?$filter=${filter}&$select=id,isDraft&$top=10`, token, fetchImpl);
    if ((page.value ?? []).some((message) => message.isDraft === false)) return true;
  }
  if (!match.conversationId) return false;
  const filter = encodeURIComponent(`conversationId eq '${match.conversationId.replace(/'/g, "''")}'`);
  const page = await graphJson<{ value?: { id: string; subject?: string | null; sentDateTime?: string | null; isDraft?: boolean }[] }>(
    `${GRAPH}/me/mailFolders/sentitems/messages?$filter=${filter}&$select=id,subject,sentDateTime,isDraft&$top=50`,
    token,
    fetchImpl,
  );
  const since = match.since.getTime() - SENT_LOOKBACK_MS;
  return (page.value ?? []).some(
    (message) => message.isDraft !== true && sameSubject(message.subject, match.subject) && new Date(message.sentDateTime ?? 0).getTime() >= since,
  );
}

export type DraftMode = "new" | "reply" | "reply_all" | "forward";

const DRAFT_ACTIONS: Record<Exclude<DraftMode, "new">, string> = { reply: "createReply", reply_all: "createReplyAll", forward: "createForward" };

function recipientsFor(list: MailAddress[]) {
  return list.map((item) => ({ emailAddress: { address: item.address, ...(item.name ? { name: item.name } : {}) } }));
}

export async function createMicrosoftDraft(token: string, messageId: string | null, mode: DraftMode, fetchImpl: typeof fetch = fetch) {
  const draft =
    mode === "new" || !messageId
      ? await graphJson<GraphMessage>(`${GRAPH}/me/messages`, token, fetchImpl, undefined, { method: "POST", body: { subject: "" } })
      : await graphJson<GraphMessage>(
          `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/${DRAFT_ACTIONS[mode]}`,
          token,
          fetchImpl,
          'outlook.body-content-type="html"',
          { method: "POST", body: {} },
        );
  return {
    id: draft.id,
    subject: mode === "new" ? null : (draft.subject ?? null),
    html: mode !== "new" && draft.body?.contentType?.toLowerCase() === "html" ? (draft.body.content ?? "") : null,
    threadKey: draft.conversationId?.slice(0, 400) ?? null,
  };
}

export async function updateMicrosoftDraft(
  token: string,
  draftId: string,
  draft: { subject: string; html: string; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] },
  fetchImpl: typeof fetch = fetch,
) {
  await graphJson<unknown>(`${GRAPH}/me/messages/${encodeURIComponent(draftId)}`, token, fetchImpl, undefined, {
    method: "PATCH",
    body: {
      subject: draft.subject,
      body: { contentType: "HTML", content: draft.html },
      toRecipients: recipientsFor(draft.to),
      ccRecipients: recipientsFor(draft.cc),
      bccRecipients: recipientsFor(draft.bcc),
    },
  });
}

export async function sendMicrosoftDraft(token: string, draftId: string, fetchImpl: typeof fetch = fetch) {
  await graphJson<unknown>(`${GRAPH}/me/messages/${encodeURIComponent(draftId)}/send`, token, fetchImpl, undefined, { method: "POST" });
}

export async function deleteMicrosoftDraft(token: string, draftId: string, fetchImpl: typeof fetch = fetch) {
  try {
    await graphJson<unknown>(`${GRAPH}/me/messages/${encodeURIComponent(draftId)}`, token, fetchImpl, undefined, { method: "DELETE" });
  } catch (error) {
    if (error instanceof GraphMailError && error.status === 404) return;
    throw error;
  }
}

export const SNOOZE_FOLDER = "Snoozed";

export async function ensureMicrosoftFolder(token: string, name: string, fetchImpl: typeof fetch = fetch) {
  const filter = encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`);
  const found = await graphJson<{ value?: GraphFolder[] }>(`${GRAPH}/me/mailFolders?$filter=${filter}&$select=id,displayName`, token, fetchImpl);
  const existing = found.value?.find((folder) => folder.displayName === name);
  if (existing) return existing.id;
  const created = await graphJson<GraphFolder>(`${GRAPH}/me/mailFolders`, token, fetchImpl, undefined, {
    method: "POST",
    body: { displayName: name },
  });
  return created.id;
}

const MAIL_SUBSCRIPTION_MINUTES = 4_200;

export async function createMailSubscription(
  token: string,
  input: { notificationUrl: string; clientState: string },
  fetchImpl: typeof fetch = fetch,
) {
  const expirationDateTime = new Date(Date.now() + MAIL_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const created = await graphJson<{ id: string; expirationDateTime?: string }>(`${GRAPH}/subscriptions`, token, fetchImpl, undefined, {
    method: "POST",
    body: {
      changeType: "created",
      notificationUrl: input.notificationUrl,
      resource: "me/mailFolders('inbox')/messages",
      expirationDateTime,
      clientState: input.clientState,
      latestSupportedTlsVersion: "v1_2",
    },
  });
  return { id: created.id, expiresAt: created.expirationDateTime ?? expirationDateTime };
}

export async function renewMailSubscription(token: string, id: string, fetchImpl: typeof fetch = fetch) {
  const expirationDateTime = new Date(Date.now() + MAIL_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const renewed = await graphJson<{ expirationDateTime?: string }>(`${GRAPH}/subscriptions/${encodeURIComponent(id)}`, token, fetchImpl, undefined, {
    method: "PATCH",
    body: { expirationDateTime },
  });
  return renewed.expirationDateTime ?? expirationDateTime;
}

type MicrosoftAttachment = { id: string; name: string; contentType: string | null; size: number; inline: boolean };

export async function listMicrosoftAttachments(token: string, messageId: string, fetchImpl: typeof fetch = fetch): Promise<MicrosoftAttachment[]> {
  const page = await graphJson<{ value?: { id: string; name?: string; contentType?: string | null; size?: number; isInline?: boolean; "@odata.type"?: string }[] }>(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    token,
    fetchImpl,
  );
  return (page.value ?? [])
    .filter((item) => item["@odata.type"] !== "#microsoft.graph.itemAttachment" || item.name)
    .map((item) => ({
      id: item.id,
      name: (item.name?.trim() || "Attachment").slice(0, 300),
      contentType: item.contentType ?? null,
      size: item.size ?? 0,
      inline: Boolean(item.isInline),
    }));
}

export async function fetchMicrosoftAttachment(token: string, messageId: string, attachmentId: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(
    graphUrl(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`),
    { headers: { authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId"' }, signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok || !response.body) {
    throw new GraphMailError(response.status === 404 ? "That attachment is no longer in Outlook." : `Microsoft answered ${response.status}.`, response.status);
  }
  return response;
}

export async function exportMicrosoftMime(token: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(graphUrl(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}/$value`), {
    headers: { authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId"' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new GraphMailError(response.status === 404 ? "The draft is no longer in Outlook." : `Microsoft answered ${response.status}.`, response.status);
  return response.text();
}

export async function saveMicrosoftSentCopy(token: string, mime: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(graphUrl(`${GRAPH}/me/mailFolders/sentitems/messages`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", prefer: 'IdType="ImmutableId"' },
    body: Buffer.from(mime, "utf8").toString("base64"),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new GraphMailError(`Microsoft answered ${response.status}.`, response.status);
  const created = (await response.json().catch(() => ({}))) as { id?: string };
  return created.id ?? null;
}
