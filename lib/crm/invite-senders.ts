import type { Db } from "@/lib/db/pool";
import { DEFAULT_CALENDAR_PLACEHOLDER, readGrantedScopes, storeGrantedScopes } from "@/lib/crm/calendar";
import { storeAccountToken } from "@/lib/crm/calendar-accounts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { currentToken, readStored, storeToken, type StoredTokens } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { CALENDAR_WRITE_RECONNECT } from "@/lib/microsoft/calendar";
import { addressHomesInDb } from "@/lib/mail/routing";
import { grantsCalendarWrite, microsoftConfigured, refreshMicrosoftToken, type MicrosoftToken } from "@/lib/microsoft/oauth";

export const INVITE_NOT_CONNECTED = "Connect Microsoft in Settings › Integrations to send invites.";
export const INVITE_RECONNECT = CALENDAR_WRITE_RECONNECT;

export type InviteSenderOption = {
  address: string;
  kind: "microsoft" | "smtp";
  primary: boolean;
  problem: string | null;
  fixHref: string | null;
};

export type GraphCalendarRef = { id: string; providerCalendarId: string | null };

export type GraphSource = {
  kind: "connection" | "account";
  id: string;
  email: string;
  tokens: StoredTokens;
  scopes: string | null;
};

export type HoldCalendar = { id: string; label: string; address: string };

export type InviteSenderCandidate = InviteSenderOption & {
  source: GraphSource | null;
  calendar: GraphCalendarRef | null;
  identityId: string | null;
  holdCalendarId: string | null;
};

type CalendarRow = {
  id: string;
  provider_calendar_id: string;
  name: string;
  is_default: boolean;
  connection_id: string | null;
  account_id: string | null;
};

type AccountRow = {
  id: string;
  email: string;
  status: string;
  can_send: boolean;
  calendar_write: boolean | null;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: Date | string | null;
};

type IdentityRow = { id: string; email: string; hold_calendar_id: string | null };

const CALENDARS_HREF = "/settings/calendars";
const INTEGRATIONS_HREF = "/settings/integrations";
const HOLDS_HREF = "/settings/email-templates#sending-addresses";

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

export function allowInvitesHref(email: string) {
  return `/api/microsoft/connect?purpose=send_account&hint=${encodeURIComponent(email)}`;
}

export function allowInvitesProblem(email: string) {
  return `Allow invites for ${email} in Settings › Calendars first.`;
}

export function chooseHoldProblem(email: string) {
  return `Choose a calendar for invite holds from ${email} in Settings › Templates and signatures.`;
}

function reconnectAccountProblem(email: string) {
  return `Reconnect ${email} in Settings › Calendars to send invites from it.`;
}

function graphCalendar(row: CalendarRow): GraphCalendarRef {
  return {
    id: row.id,
    providerCalendarId: row.provider_calendar_id === DEFAULT_CALENDAR_PLACEHOLDER ? null : row.provider_calendar_id,
  };
}

function domainLabel(email: string) {
  const domain = canonicalDomain(email.split("@")[1] ?? "") ?? "";
  const parts = domain.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : domain;
}

function commonRun(left: string, right: string) {
  let best = 0;
  for (let start = 0; start < left.length; start += 1) {
    for (let end = start + best + 1; end <= left.length; end += 1) {
      if (right.includes(left.slice(start, end))) best = end - start;
      else break;
    }
  }
  return best;
}

export function domainScore(identity: string, account: string) {
  const left = canonicalDomain(identity.split("@")[1] ?? "");
  const right = canonicalDomain(account.split("@")[1] ?? "");
  if (!left || !right) return 0;
  if (left === right) return 1000;
  const run = commonRun(domainLabel(identity), domainLabel(account));
  return run >= 4 ? run : 0;
}

async function readCalendars(db: Db, actor: UserActor) {
  const result = await db.query<CalendarRow>(
    `select id, provider_calendar_id, name, is_default, connection_id, account_id
     from crm.calendars
     where user_id = $1 and can_edit
     order by is_default desc, lower(name), id`,
    [actor.userId],
  );
  return result.rows;
}

async function readAccountRows(db: Db, actor: UserActor) {
  const result = await db.query<AccountRow>(
    `select id, email, status, can_send, calendar_write, refresh_token, access_token, access_token_expires_at
     from crm.calendar_accounts
     where user_id = $1 and provider = 'microsoft' and email is not null
     order by created_at, email`,
    [actor.userId],
  );
  return result.rows;
}

function accountScopes(write: boolean | null) {
  if (write === null) return null;
  return write ? "Calendars.ReadWrite" : "Calendars.Read";
}

function accountSource(row: AccountRow): GraphSource {
  return {
    kind: "account",
    id: row.id,
    email: canonicalEmail(row.email) ?? row.email.toLowerCase(),
    tokens: {
      refreshTokenCipher: row.refresh_token,
      accessTokenCipher: row.access_token,
      accessTokenExpiresAt: iso(row.access_token_expires_at),
    },
    scopes: accountScopes(row.calendar_write),
  };
}

function accountUsable(row: AccountRow) {
  return row.status === "connected" && Boolean(row.refresh_token) && row.can_send && row.calendar_write !== false;
}

export async function readInviteSenders(db: Db, actor: UserActor): Promise<InviteSenderCandidate[]> {
  const configured = microsoftConfigured();
  const stored = await readStored(db, actor);
  const calendars = await readCalendars(db, actor);
  const accounts = await readAccountRows(db, actor);
  const identities = await db.query<IdentityRow>(
    "select id, email, hold_calendar_id from crm.send_identities where user_id = $1 order by created_at, email",
    [actor.userId],
  );
  const senders: InviteSenderCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: InviteSenderCandidate) => {
    if (seen.has(candidate.address)) return;
    seen.add(candidate.address);
    senders.push(candidate);
  };
  const mainConnected = Boolean(configured && stored && stored.status === "connected" && stored.refreshTokenCipher);
  const mainSource: GraphSource | null =
    stored && mainConnected
      ? {
          kind: "connection",
          id: stored.id,
          email: canonicalEmail(stored.email) ?? stored.email.toLowerCase(),
          tokens: stored,
          scopes: await readGrantedScopes(db, stored.id),
        }
      : null;
  if (stored) {
    const address = canonicalEmail(stored.email) ?? stored.email.toLowerCase();
    const mainCalendar = calendars.find((row) => row.connection_id === stored.id && row.is_default) ?? null;
    const problem = !mainSource
      ? INVITE_NOT_CONNECTED
      : grantsCalendarWrite(mainSource.scopes) === false
        ? INVITE_RECONNECT
        : null;
    push({
      address,
      kind: "microsoft",
      primary: true,
      problem,
      fixHref: problem ? INTEGRATIONS_HREF : null,
      source: mainSource,
      calendar: mainCalendar ? graphCalendar(mainCalendar) : null,
      identityId: null,
      holdCalendarId: null,
    });
  }
  const accountSources = new Map<string, GraphSource>();
  for (const row of accounts) {
    if (configured && accountUsable(row)) accountSources.set(row.id, accountSource(row));
    if (!row.can_send) continue;
    const address = canonicalEmail(row.email) ?? row.email.toLowerCase();
    const calendar = calendars.find((item) => item.account_id === row.id && item.is_default) ?? null;
    const connected = row.status === "connected" && Boolean(row.refresh_token);
    const needsWrite = row.calendar_write !== true;
    const problem = !configured || !connected
      ? reconnectAccountProblem(address)
      : needsWrite
        ? allowInvitesProblem(address)
        : !calendar
          ? `${address} has no calendar Orbit can add meetings to. Check it in Settings › Calendars.`
          : null;
    push({
      address,
      kind: "microsoft",
      primary: false,
      problem,
      fixHref: problem ? (configured && connected && needsWrite ? allowInvitesHref(address) : CALENDARS_HREF) : null,
      source: accountSources.get(row.id) ?? null,
      calendar: calendar ? graphCalendar(calendar) : null,
      identityId: null,
      holdCalendarId: null,
    });
  }
  const holds = holdCalendarsFrom(calendars, mainSource, accountSources);
  for (const row of identities.rows) {
    const address = canonicalEmail(row.email) ?? row.email.toLowerCase();
    const hold = pickHold(holds, address, row.hold_calendar_id);
    const holdProblem = hold ? holdWriteProblem(hold) : null;
    const problem = holdProblem
      ? holdProblem.problem
      : hold
        ? null
        : holds.length === 0
          ? `Orbit needs a Microsoft calendar to hold the time for invites from ${address}. Connect one in Settings › Calendars.`
          : chooseHoldProblem(address);
    push({
      address,
      kind: "smtp",
      primary: false,
      problem,
      fixHref: holdProblem ? holdProblem.fixHref : problem ? (holds.length === 0 ? CALENDARS_HREF : HOLDS_HREF) : null,
      source: hold?.source ?? null,
      calendar: hold ? graphCalendar(hold.row) : null,
      identityId: row.id,
      holdCalendarId: hold?.row.id ?? null,
    });
  }
  return senders;
}

type HoldOption = { row: CalendarRow; source: GraphSource };

function holdCalendarsFrom(calendars: CalendarRow[], main: GraphSource | null, accounts: Map<string, GraphSource>) {
  const options: HoldOption[] = [];
  for (const row of calendars) {
    const source = row.connection_id
      ? main && main.id === row.connection_id
        ? main
        : null
      : row.account_id
        ? accounts.get(row.account_id) ?? null
        : null;
    if (source) options.push({ row, source });
  }
  return options;
}

function pickHold(holds: HoldOption[], address: string, chosen: string | null) {
  if (chosen) {
    const picked = holds.find((hold) => hold.row.id === chosen);
    if (picked) return picked;
  }
  let best: HoldOption | null = null;
  let bestScore = 0;
  for (const hold of holds) {
    if (!hold.row.is_default) continue;
    const score = domainScore(address, hold.source.email);
    if (score > bestScore) {
      best = hold;
      bestScore = score;
    }
  }
  return best;
}

function holdWriteProblem(hold: HoldOption) {
  const write = grantsCalendarWrite(hold.source.scopes);
  if (hold.source.kind === "connection") return write === false ? { problem: INVITE_RECONNECT, fixHref: INTEGRATIONS_HREF } : null;
  return write === true ? null : { problem: allowInvitesProblem(hold.source.email), fixHref: allowInvitesHref(hold.source.email) };
}

export async function listHoldCalendars(actor: UserActor): Promise<HoldCalendar[]> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    const configured = microsoftConfigured();
    const calendars = await readCalendars(db, actor);
    const accounts = new Map(
      (await readAccountRows(db, actor)).filter((row) => configured && accountUsable(row)).map((row) => [row.id, accountSource(row)]),
    );
    const main =
      configured && stored && stored.status === "connected" && stored.refreshTokenCipher
        ? { kind: "connection" as const, id: stored.id, email: canonicalEmail(stored.email) ?? stored.email.toLowerCase(), tokens: stored, scopes: null }
        : null;
    return holdCalendarsFrom(calendars, main, accounts).map((hold) => ({
      id: hold.row.id,
      address: hold.source.email,
      label: `${hold.source.email} · ${hold.row.name}`,
    }));
  });
}

export async function setHoldCalendar(actor: UserActor, identityId: string, calendarId: string | null) {
  if (!isUuid(identityId)) throw new CrmError("not_found", "That sending address isn't set up any more.", 404);
  if (calendarId !== null) {
    const options = await listHoldCalendars(actor);
    if (!options.some((option) => option.id === calendarId)) {
      throw new CrmError("invalid_input", "Choose a Microsoft calendar Orbit can add events to.", 400, { field: "holdCalendarId" });
    }
  }
  const updated = await withActor(actor, (db) =>
    db.query("update crm.send_identities set hold_calendar_id = $3 where id = $1 and user_id = $2", [identityId, actor.userId, calendarId]),
  );
  if (!updated.rowCount) throw new CrmError("not_found", "That sending address isn't set up any more.", 404);
}

export async function homedInviteAddress(db: Db, actor: UserActor, senders: Pick<InviteSenderOption, "address">[], workspaceId: string) {
  const homes = (await addressHomesInDb(db, actor)).filter((home) => home.workspaceId === workspaceId);
  const chosen = new Set(homes.filter((home) => home.workspaceId !== home.defaultWorkspaceId).map((home) => home.address));
  const implicit = new Set(homes.map((home) => home.address));
  return (senders.find((sender) => chosen.has(sender.address)) ?? senders.find((sender) => implicit.has(sender.address)))?.address ?? null;
}

export async function defaultInviteAddress(
  db: Db,
  actor: UserActor,
  senders: InviteSenderCandidate[],
  options: { mainFirst?: boolean } = {},
) {
  if (senders.length === 0) return null;
  const known = new Set(senders.map((sender) => sender.address));
  const home = await homedInviteAddress(db, actor, senders, actor.workspaceId);
  if (home) return home;
  const primary = senders.find((sender) => sender.primary);
  if (options.mainFirst && primary) return primary.address;
  const last = await db.query<{ address: string }>(
    "select address from crm.invite_sender_choices where user_id = $1 and workspace_id = $2",
    [actor.userId, actor.workspaceId],
  );
  const remembered = last.rows[0]?.address;
  if (remembered && known.has(remembered)) return remembered;
  return (primary ?? senders.find((sender) => !sender.problem) ?? senders[0]).address;
}

export function pickInviteSender(senders: InviteSenderCandidate[], from: unknown, fallback: string | null) {
  if (from !== undefined && from !== null && from !== "" && typeof from !== "string") {
    throw new CrmError("invalid_input", "Choose a From address.", 400, { field: "from" });
  }
  const wanted = typeof from === "string" && from.trim() ? canonicalEmail(from) ?? from.trim().toLowerCase() : null;
  if (wanted) {
    const found = senders.find((sender) => sender.address === wanted);
    if (!found) {
      throw new CrmError("not_found", `${wanted} can't send invites. Choose another From address.`, 404, { field: "from" });
    }
    return found;
  }
  const chosen = fallback ? senders.find((sender) => sender.address === fallback) : null;
  if (!chosen) throw new CrmError("not_connected", INVITE_NOT_CONNECTED, 400);
  return chosen;
}

export function assertSenderReady(sender: InviteSenderCandidate): asserts sender is InviteSenderCandidate & { source: GraphSource } {
  if (!sender.problem && sender.source) return;
  const message = sender.problem ?? INVITE_NOT_CONNECTED;
  const code = message === INVITE_NOT_CONNECTED ? "not_connected" : message === INVITE_RECONNECT ? "scope_missing" : "invalid_input";
  throw new CrmError(code, message, code === "scope_missing" ? 403 : 400, sender.primary ? undefined : { field: "from" });
}

export async function rememberInviteSender(actor: UserActor, address: string) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.invite_sender_choices (workspace_id, user_id, address) values ($1, $2, $3)
       on conflict (user_id, workspace_id) do update set address = excluded.address, updated_at = now()`,
      [actor.workspaceId, actor.userId, address],
    ),
  );
}

export function sourceReconnectMessage(source: GraphSource) {
  return source.kind === "connection" ? INVITE_RECONNECT : allowInvitesProblem(source.email);
}

async function saveSourceToken(actor: UserActor, source: GraphSource, token: MicrosoftToken) {
  await withActor(actor, async (db) => {
    if (source.kind === "account") {
      await storeAccountToken(db, source.id, token);
      return;
    }
    await storeToken(db, source.id, token);
    if (token.scope) await storeGrantedScopes(db, actor, source.id, token.scope);
  });
}

export async function writableSourceToken(
  actor: UserActor,
  source: GraphSource,
  fetchImpl: typeof fetch,
  failure: (error: unknown) => CrmError,
): Promise<MicrosoftToken> {
  const missing = () =>
    new CrmError("scope_missing", sourceReconnectMessage(source), 403, source.kind === "account" ? { field: "from" } : undefined);
  if (grantsCalendarWrite(source.scopes) === false) throw missing();
  let token: MicrosoftToken;
  let refreshed: boolean;
  try {
    token = await currentToken(source.tokens, fetchImpl);
    refreshed = token.expiresAt !== source.tokens.accessTokenExpiresAt;
    if (!token.scope && source.scopes === null) {
      token = await refreshMicrosoftToken(token.refreshToken, fetchImpl);
      refreshed = true;
    }
  } catch (error) {
    throw failure(error);
  }
  if (refreshed) await saveSourceToken(actor, source, token);
  if (grantsCalendarWrite(token.scope ?? source.scopes) === false) throw missing();
  return token;
}

export async function graphSourceFor(db: Db, actor: UserActor, row: { connection_id: string | null; account_id: string | null }) {
  if (!microsoftConfigured()) return null;
  if (row.connection_id) {
    const stored = await readStored(db, actor);
    if (!stored || stored.id !== row.connection_id || stored.status !== "connected" || !stored.refreshTokenCipher) return null;
    return {
      kind: "connection",
      id: stored.id,
      email: stored.email.toLowerCase(),
      tokens: stored,
      scopes: await readGrantedScopes(db, stored.id),
    } satisfies GraphSource;
  }
  if (row.account_id) {
    const accounts = await readAccountRows(db, actor);
    const account = accounts.find((item) => item.id === row.account_id);
    if (!account || account.status !== "connected" || !account.refresh_token) return null;
    return accountSource(account);
  }
  return null;
}

export async function accountEmail(db: Db, accountId: string) {
  const result = await db.query<{ email: string | null; provider: string }>(
    "select email, provider from crm.calendar_accounts where id = $1",
    [accountId],
  );
  return result.rows[0] ?? null;
}
