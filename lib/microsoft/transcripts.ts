import { sanitizeMicrosoftError } from "@/lib/microsoft/oauth";
import { withMicrosoftDetail } from "@/lib/microsoft/calls";

export const TRANSCRIPT_PERMISSION_MESSAGE =
  "Grant Orbit the CallTranscripts.Read.All application permission with admin consent in Microsoft Entra.";
export const TRANSCRIPTS_DISABLED_MESSAGE =
  "Your Microsoft 365 admin has turned off API access to Teams transcripts.";

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const MAX_PAGES = 20;
const TIMEOUT_MS = 20_000;

export type CallTranscript = {
  id: string;
  meetingId?: string | null;
  callId?: string | null;
  contentCorrelationId?: string | null;
  transcriptContentUrl?: string | null;
  createdDateTime?: string | null;
  endDateTime?: string | null;
  meetingOrganizer?: { user?: { id?: string | null; displayName?: string | null } | null } | null;
};

export type TranscriptRef = { userId: string; callId: string; transcriptId: string };

export type GraphSubscription = {
  id: string;
  expirationDateTime: string;
  resource?: string;
};

export class GraphError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GraphError";
    this.status = status;
  }
}

function timeout(deadline: number | undefined) {
  if (!deadline) return TIMEOUT_MS;
  return Math.max(1_000, Math.min(TIMEOUT_MS, deadline - Date.now()));
}

function graphTime(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function quoted(value: string) {
  return value.replace(/'/g, "''");
}

export function transcriptsUrl(userId: string, from: Date, to: Date) {
  return `${GRAPH}/users/${encodeURIComponent(userId)}/adhocCalls/getAllTranscripts(userId='${quoted(userId)}',startDateTime=${graphTime(from)},endDateTime=${graphTime(to)})`;
}

export function transcriptResource(userId: string) {
  return `users/${userId}/adhocCalls/getAllTranscripts`;
}

export function sanitizeTranscriptError(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.startsWith(TRANSCRIPT_PERMISSION_MESSAGE)) return compact.slice(0, 500);
  if (/GraphAccessToTranscriptsDisabled/i.test(compact)) return TRANSCRIPTS_DISABLED_MESSAGE;
  if (/Authorization_RequestDenied|Forbidden|insufficient privileges|CallTranscripts\.Read/i.test(compact)) {
    return TRANSCRIPT_PERMISSION_MESSAGE;
  }
  return sanitizeMicrosoftError(compact);
}

async function graphError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: {
      code?: string;
      message?: string;
      innerError?: { code?: string };
      innererror?: { code?: string };
    };
  };
  const codes = [
    body.error?.code,
    body.error?.innerError?.code,
    body.error?.innererror?.code,
    body.error?.message,
  ].join(" ");
  if (/GraphAccessToTranscriptsDisabled/i.test(codes)) {
    return new GraphError(TRANSCRIPTS_DISABLED_MESSAGE, response.status);
  }
  if (response.status === 403 || /Authorization_RequestDenied/i.test(codes)) {
    return new GraphError(
      withMicrosoftDetail(TRANSCRIPT_PERMISSION_MESSAGE, {
        code: body.error?.innerError?.code ?? body.error?.innererror?.code ?? body.error?.code,
        message: body.error?.message,
      }),
      response.status,
    );
  }
  if (response.status === 401) {
    return new GraphError(
      "Microsoft rejected the app token for Teams transcripts. Check the Microsoft app credentials.",
      401,
    );
  }
  return new GraphError(sanitizeTranscriptError(body.error?.message || fallback), response.status);
}

export async function fetchTranscripts(
  accessToken: string,
  userId: string,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
  deadline?: number,
) {
  const transcripts: CallTranscript[] = [];
  let next: string | null = transcriptsUrl(userId, from, to);
  let pages = 0;
  while (next) {
    if (pages >= MAX_PAGES) return { transcripts, complete: false };
    if (pages > 0 && deadline && deadline - Date.now() < 3_000) {
      return { transcripts, complete: false };
    }
    pages += 1;
    const response = await fetchImpl(next, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeout(deadline)),
    });
    if (!response.ok) throw await graphError(response, "Microsoft could not list Teams transcripts.");
    const body = (await response.json()) as {
      value?: CallTranscript[];
      "@odata.nextLink"?: string;
    };
    transcripts.push(...(body.value ?? []).filter((item) => item && typeof item.id === "string"));
    const link = body["@odata.nextLink"] ?? null;
    next = link && link.startsWith(`${GRAPH}/`) ? link : null;
  }
  return { transcripts, complete: true };
}

export async function fetchTranscript(
  accessToken: string,
  ref: TranscriptRef,
  fetchImpl: typeof fetch = fetch,
  deadline?: number,
): Promise<CallTranscript | null> {
  const response = await fetchImpl(
    `${GRAPH}/users/${encodeURIComponent(ref.userId)}/adhocCalls/${encodeURIComponent(ref.callId)}/transcripts/${encodeURIComponent(ref.transcriptId)}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeout(deadline)),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await graphError(response, "Microsoft could not read the Teams transcript.");
  return (await response.json()) as CallTranscript;
}

export function transcriptContentUrl(userId: string, transcript: CallTranscript) {
  const given = transcript.transcriptContentUrl?.trim();
  const base =
    given && given.startsWith(`${GRAPH}/`)
      ? given
      : transcript.callId
        ? `${GRAPH}/users/${encodeURIComponent(userId)}/adhocCalls/${encodeURIComponent(transcript.callId)}/transcripts/${encodeURIComponent(transcript.id)}/content`
        : null;
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}$format=text/vtt`;
}

export async function fetchTranscriptContent(
  accessToken: string,
  userId: string,
  transcript: CallTranscript,
  fetchImpl: typeof fetch = fetch,
  deadline?: number,
) {
  const url = transcriptContentUrl(userId, transcript);
  if (!url) throw new GraphError("Microsoft did not say where the transcript content is.", 400);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "text/vtt" },
    signal: AbortSignal.timeout(timeout(deadline)),
  });
  if (!response.ok) throw await graphError(response, "Microsoft could not download the Teams transcript.");
  return response.text();
}

export async function createSubscription(
  accessToken: string,
  input: {
    userId: string;
    notificationUrl: string;
    lifecycleNotificationUrl: string;
    clientState: string;
    expiresAt: Date;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphSubscription> {
  const response = await fetchImpl(`${GRAPH_BETA}/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.lifecycleNotificationUrl,
      resource: transcriptResource(input.userId),
      includeResourceData: false,
      expirationDateTime: input.expiresAt.toISOString(),
      clientState: input.clientState,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw await graphError(response, "Microsoft could not create the transcript subscription.");
  return (await response.json()) as GraphSubscription;
}

export async function renewSubscription(
  accessToken: string,
  subscriptionId: string,
  expiresAt: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphSubscription | null> {
  const response = await fetchImpl(`${GRAPH_BETA}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await graphError(response, "Microsoft could not renew the transcript subscription.");
  return (await response.json()) as GraphSubscription;
}

export function parseTranscriptResource(resource: string | null | undefined): TranscriptRef | null {
  if (!resource) return null;
  const path = resource
    .replace(/^https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)\//i, "")
    .replace(/\('([^']*)'\)/g, "/$1")
    .replace(/^\/+/, "");
  const match = /(?:^|\/)users\/([^/]+)\/adhocCalls\/([^/]+)\/transcripts\/([^/?]+)/i.exec(path);
  if (!match) return null;
  return { userId: match[1], callId: match[2], transcriptId: match[3] };
}
