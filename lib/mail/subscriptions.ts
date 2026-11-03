import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { moveMessages, type MessageMove } from "@/lib/mail/actions";
import { sendMailDraft } from "@/lib/mail/compose";
import { stripQuoted } from "@/lib/mail/format";
import { ensureMicrosoftFolder, fetchMicrosoftHeaders, GraphMailError } from "@/lib/mail/microsoft";
import { AUTOMATED_DOMAIN, AUTOMATED_SENDER, CALENDAR_SENDER, CALENDAR_SUBJECT, senderKey, splitJoin } from "@/lib/mail/split";
import { mailSourceToken } from "@/lib/mail/sync";
import { parseThreadKey } from "@/lib/mail/threads";
import { chooseMethod, listUnsubscribeFrom, postOneClick, UnsubscribeRefused, type Lookup, type Mailto } from "@/lib/mail/unsubscribe";
import type {
  ExistingMailChoice,
  SenderProtection,
  SubscriptionSender,
  SubscriptionStatus,
  ThreadSubscription,
  UnsubscribeMethod,
  UnsubscribeOutcome,
  UnsubscribePreview,
  UnsubscribeResult,
} from "@/lib/mail/view";

const IGNORE_AFTER_DAYS = 7;
export const REVIEW_DAYS = 90;
const RESEARCH_FOLDER = "Research";
export const SENDER_ACTIONS = ["keep", "research", "block", "subscribe"] as const;
type SenderAction = (typeof SENDER_ACTIONS)[number];
export const EXISTING_CHOICES: ExistingMailChoice[] = ["archive", "trash", "leave"];

const PROTECTED_LIFECYCLES: Record<string, string> = { customer: "client", client: "client", prospect: "prospect", partner: "partner" };
const UNSUBSCRIBE_TEXT = "(unsubscribe|opt[ -]?out|manage (your )?(email |subscription )?preferences|email preferences)";
const MOVE_LIMIT = 2_000;
const MOVE_CHUNK = 40;
const INLINE_MOVE_MS = 25_000;
const BACKGROUND_MOVE_MS = 240_000;
const BULK_PARALLEL = 3;
const BULK_RESERVE_MS = 20_000;
const SCOPES: Record<"archive" | "trash" | "research", string[]> = {
  archive: ["inbox"],
  trash: ["inbox", "archive", "other", "snoozed"],
  research: ["inbox"],
};
const STATUS_FOR: Record<SenderAction, "kept" | "research" | "blocked" | "subscribed"> = {
  keep: "kept",
  research: "research",
  block: "blocked",
  subscribe: "subscribed",
};

type Stored = {
  sender: string;
  status: "subscribed" | "kept" | "unsubscribed" | "research" | "blocked";
  unsubscribed_at: Date | null;
  method: UnsubscribeMethod | null;
  outcome: UnsubscribeOutcome | null;
  ignored_at: Date | null;
  cold_pitch_at: Date | null;
  list_unsubscribe: string | null;
};

type Defer = (work: () => Promise<unknown>) => void;

type UnsubscribeOptions = {
  fetchImpl?: typeof fetch;
  postFetch?: typeof fetch;
  lookup?: Lookup;
  deadline?: number;
  defer?: Defer;
};

const STORED_COLUMNS = "sender, status, unsubscribed_at, method, outcome, ignored_at, cold_pitch_at, list_unsubscribe";

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function ownSql(userParam: string, emailParam: string) {
  return `(
    select lower(s.email) from crm.mail_sources s where s.user_id = ${userParam}
    union select lower(i.email) from crm.send_identities i where i.user_id = ${userParam}
    union select lower(${emailParam}::text)
  )`;
}

function recordFor(alias: string, userParam: string) {
  return `left join lateral (
    select ms.sender, ms.status, ms.unsubscribed_at, ms.cold_pitch_at from crm.mail_subscriptions ms
    where ms.user_id = ${userParam}
      and (ms.sender = lower(${alias}.from_email) or ms.sender = '@' || split_part(lower(${alias}.from_email), '@', 2))
    order by ms.sender like '@%'
    limit 1
  ) sub on true`;
}

function senderMatch(alias: string, param: string) {
  return `(case when ${param} like '@%' then split_part(lower(${alias}.from_email), '@', 2) = substr(${param}, 2) else lower(${alias}.from_email) = ${param} end)`;
}

function viewStatus(row: Pick<Stored, "status" | "ignored_at"> | null | undefined): SubscriptionStatus {
  if (!row) return "subscribed";
  if (row.status === "unsubscribed" && row.ignored_at) return "ignored";
  return row.status;
}

function readKey(value: string) {
  const key = senderKey(value);
  if (!key) throw new CrmError("invalid_input", "Choose an email address or @domain.", 400, { field: "sender" });
  return key;
}

function domainOf(key: string) {
  return key.startsWith("@") ? key.slice(1) : (key.split("@")[1] ?? "");
}

async function protectionFor(db: Db, actor: UserActor, keys: string[]): Promise<Map<string, SenderProtection>> {
  const found = new Map<string, SenderProtection>();
  const addresses = [...new Set(keys.filter((key) => !key.startsWith("@")))];
  const domains = [...new Set(keys.map(domainOf).filter(Boolean))];
  if (keys.length === 0) return found;
  const contacts = addresses.length
    ? await db.query<{ id: string; name: string | null; normalized_email: string }>(
        `select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') as name, normalized_email from crm.contacts
         where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])`,
        [actor.workspaceId, addresses],
      )
    : { rows: [] };
  const companies = domains.length
    ? await db.query<{ id: string; name: string; domain: string; lifecycle: string }>(
        `select id, name, domain, lifecycle from crm.companies
         where workspace_id = $1 and archived_at is null and domain = any($2::text[]) and lower(btrim(lifecycle)) = any($3::text[])`,
        [actor.workspaceId, domains, Object.keys(PROTECTED_LIFECYCLES)],
      )
    : { rows: [] };
  for (const key of keys) {
    const contact = key.startsWith("@") ? undefined : contacts.rows.find((row) => row.normalized_email === key);
    if (contact) {
      const name = contact.name ?? key;
      found.set(key, { kind: "contact", id: contact.id, name, href: contactHref(contact.id), reason: `${name} is a contact in Orbit.` });
      continue;
    }
    const company = companies.rows.find((row) => row.domain === domainOf(key));
    if (company) {
      const word = PROTECTED_LIFECYCLES[company.lifecycle.trim().toLowerCase()] ?? "client";
      found.set(key, { kind: "company", id: company.id, name: company.name, href: companyHref(company.id), reason: `${company.name} is a ${word} in Orbit.` });
    }
  }
  return found;
}

export async function senderProtection(actor: UserActor, senders: string[]) {
  const keys = senders.map((sender) => senderKey(sender)).filter((key): key is string => Boolean(key));
  return withActor(actor, (db) => protectionFor(db, actor, keys));
}

async function storedRecords(db: Db, actor: UserActor) {
  const result = await db.query<Stored>(`select ${STORED_COLUMNS} from crm.mail_subscriptions where user_id = $1`, [actor.userId]);
  return result.rows;
}

async function effectiveRecord(db: Db, actor: UserActor, key: string) {
  const result = await db.query<Stored>(
    `select ${STORED_COLUMNS} from crm.mail_subscriptions
     where user_id = $1 and (sender = $2 or sender = '@' || $3)
     order by sender like '@%' limit 1`,
    [actor.userId, key, domainOf(key)],
  );
  return result.rows[0] ?? null;
}

type Group = { key: string; name: string | null; top: number; emails: number; opened: number; lastAt: Date | null; bulk: boolean };

export async function listSubscriptions(actor: UserActor, options: { days?: number } = {}): Promise<{ days: number; senders: SubscriptionSender[] }> {
  const days = Math.min(Math.max(Math.trunc(options.days ?? REVIEW_DAYS), 7), 365);
  return withActor(actor, async (db) => {
    const stats = await db.query<{ sender: string; name: string | null; emails: number; opened: number; last_at: Date; bulk: boolean; calendar: boolean }>(
      `select lower(m.from_email) as sender,
         (array_agg(m.from_name order by coalesce(m.received_at, m.created_at) desc) filter (where nullif(btrim(m.from_name), '') is not null))[1] as name,
         count(*)::int as emails,
         (count(*) filter (where m.is_read))::int as opened,
         max(coalesce(m.received_at, m.created_at)) as last_at,
         coalesce(bool_or(
           coalesce(rule.split = 'news', false)
           or m.from_email ~* '${AUTOMATED_SENDER}'
           or m.from_email ~* '${AUTOMATED_DOMAIN}'
           or right(coalesce(m.body_text, ''), 4000) ~* '${UNSUBSCRIBE_TEXT}'
         ), false) as bulk,
         coalesce(bool_and(
           coalesce(rule.split = 'calendar', false) or coalesce(m.subject, '') ~* '${CALENDAR_SUBJECT}' or m.from_email ~* '${CALENDAR_SENDER}'
         ), false) as calendar
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       ${splitJoin("m", "$1")}
       where m.user_id = $1 and f.role not in ('sent', 'drafts', 'junk', 'outbox') and not m.is_draft
         and nullif(m.from_email, '') is not null
         and coalesce(m.received_at, m.created_at) > now() - make_interval(days => $3)
         and lower(m.from_email) not in (select own.email from ${ownSql("$1", "$2")} as own(email) where own.email is not null)
       group by lower(m.from_email)`,
      [actor.userId, actor.email, days],
    );
    const records = await storedRecords(db, actor);
    const byKey = new Map(records.map((row) => [row.sender, row]));
    const groups = new Map<string, Group>();
    for (const row of stats.rows) {
      if (row.calendar) continue;
      const record = byKey.get(row.sender) ?? byKey.get(`@${domainOf(row.sender)}`);
      const key = record?.sender ?? row.sender;
      const group = groups.get(key) ?? { key, name: null, top: -1, emails: 0, opened: 0, lastAt: null, bulk: false };
      group.emails += row.emails;
      group.opened += row.opened;
      if (!group.lastAt || new Date(row.last_at) > group.lastAt) group.lastAt = new Date(row.last_at);
      if (row.emails > group.top) {
        group.top = row.emails;
        group.name = row.name;
      }
      group.bulk = group.bulk || row.bulk || Boolean(record?.list_unsubscribe);
      groups.set(key, group);
    }
    for (const record of records) {
      if (groups.has(record.sender)) continue;
      if (record.status === "subscribed" && !record.cold_pitch_at && !record.list_unsubscribe) continue;
      groups.set(record.sender, { key: record.sender, name: null, top: 0, emails: 0, opened: 0, lastAt: null, bulk: true });
    }
    const listed = [...groups.values()].filter((group) => {
      const record = byKey.get(group.key);
      return group.bulk || (record && (record.status !== "subscribed" || record.cold_pitch_at));
    });
    const protections = await protectionFor(db, actor, listed.map((group) => group.key));
    return {
      days,
      senders: listed
        .map((group): SubscriptionSender => {
          const record = byKey.get(group.key);
          const status = viewStatus(record);
          const protection = protections.get(group.key) ?? null;
          return {
            sender: group.key,
            name: group.name,
            emails: group.emails,
            opened: group.opened,
            lastAt: iso(group.lastAt),
            status,
            unsubscribedAt: iso(record?.unsubscribed_at),
            method: record?.method ?? null,
            ignoredAt: iso(record?.ignored_at),
            coldPitch: Boolean(record?.cold_pitch_at),
            protection,
            suggest: status === "subscribed" && !protection && group.emails > 0 && group.opened === 0,
          };
        })
        .sort((a, b) => b.emails - a.emails || (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.sender.localeCompare(b.sender)),
    };
  });
}

export function unopenedSenders(senders: SubscriptionSender[]) {
  return senders.filter((sender) => sender.suggest);
}

type SenderMessage = { id: string; source_id: string; provider_message_id: string; from_email: string; from_name: string | null; account: string };

async function latestMessage(db: Db, actor: UserActor, input: { thread?: string; sender?: string }) {
  if (input.thread) {
    const { sourceId, key } = parseThreadKey(input.thread);
    const result = await db.query<SenderMessage>(
      `select m.id, m.source_id, m.provider_message_id, lower(m.from_email) as from_email, m.from_name, s.email as account
       from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3
         and f.role not in ('sent', 'drafts', 'junk', 'outbox') and not m.is_draft and nullif(m.from_email, '') is not null
         and lower(m.from_email) not in (select own.email from ${ownSql("$1", "$4")} as own(email) where own.email is not null)
       order by coalesce(m.received_at, m.created_at) desc limit 1`,
      [actor.userId, sourceId, key, actor.email],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "This conversation has no email from anyone else to unsubscribe from.", 404);
    return row;
  }
  const key = readKey(input.sender ?? "");
  const result = await db.query<SenderMessage>(
    `select m.id, m.source_id, m.provider_message_id, lower(m.from_email) as from_email, m.from_name, s.email as account
     from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and f.role not in ('sent', 'drafts', 'junk', 'outbox') and not m.is_draft and ${senderMatch("m", "$2::text")}
     order by coalesce(m.received_at, m.created_at) desc limit 1`,
    [actor.userId, key],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", `Orbit has no email from ${key} to unsubscribe with. Block them instead.`, 404);
  return row;
}

async function readLink(actor: UserActor, message: SenderMessage, fetchImpl: typeof fetch) {
  const token = await mailSourceToken(actor, message.source_id, fetchImpl);
  try {
    return listUnsubscribeFrom(await fetchMicrosoftHeaders(token, message.provider_message_id, fetchImpl));
  } catch (error) {
    if (error instanceof GraphMailError) throw new CrmError("upstream_error", error.message, 502);
    throw error;
  }
}

async function rememberLink(db: Db, actor: UserActor, address: string, raw: string | null, oneClick: boolean) {
  if (!raw) return;
  const existing = await effectiveRecord(db, actor, address);
  await db.query(
    `insert into crm.mail_subscriptions (workspace_id, user_id, sender, list_unsubscribe, one_click) values ($1, $2, $3, $4, $5)
     on conflict (user_id, sender) do update set list_unsubscribe = excluded.list_unsubscribe, one_click = excluded.one_click, updated_at = now()`,
    [actor.workspaceId, actor.userId, existing?.sender ?? address, raw, oneClick],
  );
}

async function countSenderMail(db: Db, actor: UserActor, key: string) {
  const result = await db.query<{ inbox: number; total: number }>(
    `select (count(*) filter (where f.role = 'inbox'))::int as inbox, (count(*) filter (where f.role = any($3::text[])))::int as total
     from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and not m.is_draft and ${senderMatch("m", "$2::text")}`,
    [actor.userId, key, SCOPES.trash],
  );
  return { inbox: result.rows[0]?.inbox ?? 0, total: result.rows[0]?.total ?? 0 };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export async function unsubscribePreview(actor: UserActor, input: { thread?: string; sender?: string }, fetchImpl: typeof fetch = fetch): Promise<UnsubscribePreview> {
  const message = await withActor(actor, (db) => latestMessage(db, actor, input));
  const { raw, parsed } = await readLink(actor, message, fetchImpl);
  const method = chooseMethod(parsed);
  const key = input.sender ? readKey(input.sender) : message.from_email;
  return withActor(actor, async (db) => {
    await rememberLink(db, actor, message.from_email, raw, parsed.oneClick);
    const record = await effectiveRecord(db, actor, key);
    const protection = (await protectionFor(db, actor, [key])).get(key) ?? null;
    return {
      sender: key,
      name: message.from_name,
      method,
      target: method === "mailto" ? parsed.mailto[0].address : method === "one_click" ? hostOf(parsed.https[0]) : method === "page" ? hostOf(parsed.pages[0]) : null,
      pageUrl: method === "page" ? parsed.pages[0] : null,
      account: message.account,
      protection,
      status: viewStatus(record),
      existing: await countSenderMail(db, actor, key),
    };
  });
}

async function researchFolder(actor: UserActor, sourceId: string, fetchImpl: typeof fetch) {
  const stored = await withActor(actor, async (db) => {
    const result = await db.query<{ research_folder_id: string | null; known: boolean }>(
      `select s.research_folder_id,
         exists (select 1 from crm.mail_folders f where f.source_id = s.id and f.provider_folder_id = s.research_folder_id) as known
       from crm.mail_sources s where s.id = $1`,
      [sourceId],
    );
    const row = result.rows[0];
    return row?.research_folder_id && row.known ? row.research_folder_id : null;
  });
  if (stored) return stored;
  const token = await mailSourceToken(actor, sourceId, fetchImpl);
  const providerId = await ensureMicrosoftFolder(token, RESEARCH_FOLDER, fetchImpl);
  await withActor(actor, async (db) => {
    await db.query("update crm.mail_sources set research_folder_id = $2 where id = $1", [sourceId, providerId]);
    await db.query(
      `insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role, sync_state)
       values ($1, $2, $3, $4, $5, 'other', 'pending')
       on conflict (source_id, provider_folder_id) do nothing`,
      [actor.workspaceId, actor.userId, sourceId, providerId, RESEARCH_FOLDER],
    );
  });
  return providerId;
}

type MoveRow = { id: string; source_id: string; provider_message_id: string; tk: string };

async function moveGrouped(actor: UserActor, rows: MoveRow[], choice: "archive" | "trash" | "research", deadline: number, fetchImpl: typeof fetch) {
  const bySource = new Map<string, MoveRow[]>();
  for (const row of rows) bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row]);
  let moved = 0;
  let attempted = 0;
  let error: string | null = null;
  for (const [sourceId, list] of bySource) {
    let target: MessageMove;
    try {
      target = choice === "research" ? { providerFolderId: await researchFolder(actor, sourceId, fetchImpl), role: "other" } : choice;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : "Outlook didn't make the Research folder.";
      continue;
    }
    for (let index = 0; index < list.length; index += MOVE_CHUNK) {
      if (Date.now() >= deadline) return { moved, remaining: rows.length - attempted, error };
      const chunk = list.slice(index, index + MOVE_CHUNK);
      attempted += chunk.length;
      try {
        const result = await moveMessages(
          actor,
          sourceId,
          chunk.map((row) => ({ id: row.id, providerMessageId: row.provider_message_id, threadKey: row.tk })),
          target,
          fetchImpl,
        );
        moved += result.moved.length;
        error = error ?? result.error;
      } catch (problem) {
        error = problem instanceof Error ? problem.message : "Outlook didn't move the emails.";
        break;
      }
    }
  }
  return { moved, remaining: 0, error };
}

async function clearSenderMail(
  actor: UserActor,
  sender: string,
  choice: "archive" | "trash" | "research",
  options: { fetchImpl?: typeof fetch; deadline?: number } = {},
) {
  const key = readKey(sender);
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<MoveRow>(
      `select m.id, m.source_id, m.provider_message_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and f.role = any($3::text[]) and not m.is_draft and ${senderMatch("m", "$2::text")}
       order by coalesce(m.received_at, m.created_at) desc limit $4`,
      [actor.userId, key, SCOPES[choice], MOVE_LIMIT],
    );
    return result.rows;
  });
  return moveGrouped(actor, rows, choice, options.deadline ?? Date.now() + BACKGROUND_MOVE_MS, options.fetchImpl ?? fetch);
}

async function clearWithin(actor: UserActor, key: string, choice: "archive" | "trash" | "research", options: UnsubscribeOptions) {
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + INLINE_MOVE_MS);
  const cleared = await clearSenderMail(actor, key, choice, { fetchImpl: options.fetchImpl, deadline });
  if (cleared.remaining > 0 && options.defer) {
    options.defer(() =>
      clearSenderMail(actor, key, choice, { fetchImpl: options.fetchImpl }).catch((error) => console.error("Moving a sender's mail failed", error)),
    );
  }
  return cleared;
}

async function sendMailto(actor: UserActor, sourceId: string, mailto: Mailto, fetchImpl: typeof fetch) {
  await sendMailDraft(
    actor,
    {
      id: null,
      mode: "new",
      messageId: null,
      sourceId,
      to: [{ address: mailto.address, name: null }],
      cc: [],
      bcc: [],
      subject: mailto.subject,
      body: mailto.body,
      signature: false,
      remindHours: null,
    },
    { origin: null, fetchImpl, storedFiles: "keep" },
  );
}

function readChoice(value: unknown): ExistingMailChoice {
  return EXISTING_CHOICES.find((choice) => choice === value) ?? "archive";
}

export async function unsubscribe(
  actor: UserActor,
  input: { thread?: string; sender?: string; existing?: ExistingMailChoice; block?: boolean; confirmed?: boolean },
  options: UnsubscribeOptions = {},
): Promise<UnsubscribeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const choice = readChoice(input.existing);
  const message = await withActor(actor, (db) => latestMessage(db, actor, input));
  const key = input.sender ? readKey(input.sender) : message.from_email;
  const protection = (await withActor(actor, (db) => protectionFor(db, actor, [key]))).get(key);
  if (protection && !input.confirmed) {
    throw new CrmError("protected", `${protection.reason} Confirm to ${input.block ? "unsubscribe and block" : "unsubscribe"} anyway.`, 409, { field: "confirmed" });
  }
  const { raw, parsed } = await readLink(actor, message, fetchImpl);
  let method = chooseMethod(parsed);
  let outcome: UnsubscribeOutcome | null = null;
  let url: string | null = null;
  let target: string | null = null;
  let detail: string | null = null;
  let refused = false;
  if (method === "one_click") {
    target = hostOf(parsed.https[0]);
    try {
      const posted = await postOneClick(parsed.https[0], { fetchImpl: options.postFetch, lookup: options.lookup });
      if (posted.ok) outcome = "unsubscribed";
      else detail = `${posted.host} answered ${posted.status}.`;
    } catch (error) {
      refused = error instanceof UnsubscribeRefused;
      detail = error instanceof Error ? error.message : "The unsubscribe link didn't answer.";
    }
  }
  if (!outcome && parsed.mailto.length && (method === "one_click" || method === "mailto")) {
    method = "mailto";
    target = parsed.mailto[0].address;
    try {
      await sendMailto(actor, message.source_id, parsed.mailto[0], fetchImpl);
      outcome = "requested";
    } catch (error) {
      detail = error instanceof Error ? error.message : "The unsubscribe email didn't send.";
    }
  }
  if (!outcome && parsed.pages.length && !refused) {
    method = "page";
    url = parsed.pages[0];
    target = hostOf(url);
    outcome = "needs_you";
  }
  const final: UnsubscribeOutcome = outcome ?? (method === "none" ? "none" : "failed");
  const succeeded = final === "unsubscribed" || final === "requested" || final === "needs_you";
  const status = input.block ? "blocked" : succeeded ? "unsubscribed" : null;
  const moving = Boolean(succeeded || input.block);
  const record = await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.mail_unsubscribes (workspace_id, user_id, sender, source_id, message_id, method, outcome, target, detail, existing)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actor.workspaceId,
        actor.userId,
        key,
        message.source_id,
        message.id,
        method,
        final,
        target?.slice(0, 2000) ?? null,
        detail?.slice(0, 500) ?? null,
        moving ? choice : "leave",
      ],
    );
    const saved = await db.query<Stored>(
      `insert into crm.mail_subscriptions (workspace_id, user_id, sender, status, unsubscribed_at, method, outcome, list_unsubscribe, one_click)
       values ($1, $2, $3, coalesce($4, 'subscribed'), case when $5 then now() end, $6, $7, $8, $9)
       on conflict (user_id, sender) do update set
         status = coalesce($4, crm.mail_subscriptions.status),
         unsubscribed_at = case when $5 then now() else crm.mail_subscriptions.unsubscribed_at end,
         ignored_at = case when $5 or $4 = 'blocked' then null else crm.mail_subscriptions.ignored_at end,
         ignored_count = case when $5 then 0 else crm.mail_subscriptions.ignored_count end,
         method = excluded.method,
         outcome = excluded.outcome,
         list_unsubscribe = coalesce(excluded.list_unsubscribe, crm.mail_subscriptions.list_unsubscribe),
         one_click = excluded.one_click,
         updated_at = now()
       returning ${STORED_COLUMNS}`,
      [actor.workspaceId, actor.userId, key, status, succeeded, method, final, raw, parsed.oneClick],
    );
    return saved.rows[0];
  });
  const cleared = moving && choice !== "leave" ? await clearWithin(actor, key, choice, options) : { moved: 0, remaining: 0, error: null };
  return {
    sender: key,
    method,
    outcome: final,
    url,
    detail: detail ?? cleared.error,
    moved: cleared.moved,
    remaining: cleared.remaining,
    status: viewStatus(record),
  };
}

export async function unsubscribeMany(
  actor: UserActor,
  senders: string[],
  input: { existing?: ExistingMailChoice; confirmed?: boolean },
  options: UnsubscribeOptions = {},
) {
  const keys = [...new Set(senders.map((sender) => senderKey(sender)).filter((key): key is string => Boolean(key)))].slice(0, 100);
  const results: (UnsubscribeResult | { sender: string; error: string })[] = new Array(keys.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BULK_PARALLEL, keys.length) }, async () => {
      while (next < keys.length) {
        const index = next++;
        const sender = keys[index];
        if (options.deadline && Date.now() > options.deadline - BULK_RESERVE_MS) {
          results[index] = { sender, error: "Orbit ran out of time before this one. Try it again." };
          continue;
        }
        try {
          results[index] = await unsubscribe(actor, { sender, existing: input.existing, confirmed: input.confirmed }, options);
        } catch (error) {
          results[index] = { sender, error: error instanceof Error ? error.message : "That didn't work." };
        }
      }
    }),
  );
  return results;
}

export async function setSubscription(
  actor: UserActor,
  input: { sender: string; action: SenderAction; existing?: ExistingMailChoice; confirmed?: boolean },
  options: UnsubscribeOptions = {},
) {
  if (!SENDER_ACTIONS.includes(input.action)) throw new CrmError("invalid_input", "Choose keep, research, block or subscribe.", 400, { field: "action" });
  const key = readKey(input.sender);
  if (input.action === "block" && !input.confirmed) {
    const protection = (await withActor(actor, (db) => protectionFor(db, actor, [key]))).get(key);
    if (protection) throw new CrmError("protected", `${protection.reason} Confirm to block them anyway.`, 409, { field: "confirmed" });
  }
  const status = STATUS_FOR[input.action];
  const record = await withActor(actor, async (db) => {
    const result = await db.query<Stored>(
      `insert into crm.mail_subscriptions (workspace_id, user_id, sender, status) values ($1, $2, $3, $4)
       on conflict (user_id, sender) do update set
         status = excluded.status,
         ignored_at = case when excluded.status = 'subscribed' then null else crm.mail_subscriptions.ignored_at end,
         updated_at = now()
       returning ${STORED_COLUMNS}`,
      [actor.workspaceId, actor.userId, key, status],
    );
    return result.rows[0];
  });
  const choice = input.action === "research" ? "research" : input.action === "block" ? readChoice(input.existing) : "leave";
  const cleared = choice !== "leave" ? await clearWithin(actor, key, choice, options) : { moved: 0, remaining: 0, error: null };
  return { sender: key, status: viewStatus(record), moved: cleared.moved, remaining: cleared.remaining, error: cleared.error };
}

type Arrival = {
  id: string;
  source_id: string;
  provider_message_id: string;
  tk: string;
  at: Date;
  sender: string;
  status: Stored["status"];
  unsubscribed_at: Date | null;
  cold_pitch_at: Date | null;
  replied: boolean;
  cold_pitches: string;
};

export async function routeArrivedMail(actor: UserActor, ids: string[], options: { fetchImpl?: typeof fetch; now?: number } = {}) {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return [];
  const now = options.now ?? Date.now();
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<Arrival>(
      `select m.id, m.source_id, m.provider_message_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk,
         coalesce(m.received_at, m.created_at) as at, sub.sender, sub.status, sub.unsubscribed_at, sub.cold_pitch_at,
         coalesce((select p.cold_pitches from crm.mail_preferences p where p.user_id = $1 and p.workspace_id = $3), 'off') as cold_pitches,
         exists (
           select 1 from crm.mail_messages s join crm.mail_folders sf on sf.id = s.folder_id
           where s.user_id = $1 and sf.role = 'sent' and s.to_recipients @> jsonb_build_array(jsonb_build_object('address', lower(m.from_email)))
         ) as replied
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id and f.role = 'inbox'
       ${recordFor("m", "$1")}
       where m.user_id = $1 and m.id = any($2::uuid[]) and sub.sender is not null`,
      [actor.userId, wanted, actor.workspaceId],
    );
    return result.rows;
  });
  const plans: { row: Arrival; choice: "archive" | "research"; ignored: boolean }[] = [];
  for (const row of rows) {
    if (row.status === "blocked") plans.push({ row, choice: "archive", ignored: false });
    else if (row.status === "research") plans.push({ row, choice: "research", ignored: false });
    else if (row.status === "unsubscribed" && row.unsubscribed_at && new Date(row.at).getTime() > new Date(row.unsubscribed_at).getTime() + IGNORE_AFTER_DAYS * 86_400_000) {
      plans.push({ row, choice: "archive", ignored: true });
    } else if (row.status === "subscribed" && row.cold_pitch_at && row.cold_pitches === "archive" && !row.replied) {
      plans.push({ row, choice: "archive", ignored: false });
    }
  }
  if (plans.length === 0) return [];
  const ignored = new Map<string, number>();
  for (const plan of plans) if (plan.ignored) ignored.set(plan.row.sender, (ignored.get(plan.row.sender) ?? 0) + 1);
  if (ignored.size) {
    await withActor(actor, async (db) => {
      for (const [sender, count] of ignored) {
        await db.query(
          `update crm.mail_subscriptions set ignored_at = coalesce(ignored_at, to_timestamp($3::double precision / 1000)), ignored_count = ignored_count + $4, updated_at = now()
           where user_id = $1 and sender = $2 and status = 'unsubscribed'`,
          [actor.userId, sender, now, count],
        );
      }
    });
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const routed: string[] = [];
  for (const choice of ["archive", "research"] as const) {
    const chosen = plans.filter((plan) => plan.choice === choice).map((plan) => ({ id: plan.row.id, source_id: plan.row.source_id, provider_message_id: plan.row.provider_message_id, tk: plan.row.tk }));
    if (chosen.length === 0) continue;
    const before = new Set(chosen.map((row) => row.id));
    const result = await moveGrouped(actor, chosen, choice, Date.now() + 60_000, fetchImpl).catch((error) => {
      console.error("Moving arrived mail failed", error instanceof Error ? error.message : error);
      return null;
    });
    if (result?.error) console.error("Moving arrived mail failed", result.error);
    const still = await withActor(actor, async (db) => {
      const left = await db.query<{ id: string }>(
        "select m.id from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.id = any($1::uuid[]) and f.role = 'inbox'",
        [[...before]],
      );
      return new Set(left.rows.map((row) => row.id));
    });
    for (const id of before) if (!still.has(id)) routed.push(id);
  }
  return routed;
}

export async function threadSubscription(db: Db, actor: UserActor, address: string | null): Promise<ThreadSubscription | null> {
  const key = address ? senderKey(address) : null;
  if (!key) return null;
  const record = await effectiveRecord(db, actor, key);
  if (!record) return null;
  return {
    sender: record.sender,
    status: viewStatus(record),
    ignoredAt: iso(record.ignored_at),
    unsubscribedAt: iso(record.unsubscribed_at),
    coldPitch: Boolean(record.cold_pitch_at),
  };
}

type ResearchEmail = { id: string; from: string; name: string | null; subject: string | null; receivedAt: string | null; account: string; text: string };

export async function researchMail(actor: UserActor, options: { hours?: number; limit?: number } = {}): Promise<ResearchEmail[]> {
  const hours = Math.min(Math.max(Math.trunc(options.hours ?? 24), 1), 24 * 30);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; from_email: string; from_name: string | null; subject: string | null; at: Date; account: string; body_text: string | null; snippet: string | null }>(
      `select m.id, lower(m.from_email) as from_email, m.from_name, m.subject, coalesce(m.received_at, m.created_at) as at, s.email as account, m.body_text, m.snippet
       from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       join crm.mail_sources s on s.id = m.source_id
       ${recordFor("m", "$1")}
       where m.user_id = $1 and sub.status = 'research' and f.role not in ('trash', 'junk', 'outbox', 'sent', 'drafts') and not m.is_draft
         and coalesce(m.received_at, m.created_at) > now() - make_interval(hours => $2)
       order by coalesce(m.received_at, m.created_at) desc
       limit $3`,
      [actor.userId, hours, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      from: row.from_email,
      name: row.from_name,
      subject: row.subject,
      receivedAt: iso(row.at),
      account: row.account,
      text: stripQuoted(row.body_text ?? row.snippet ?? ""),
    }));
  });
}

export async function markColdPitch(
  actor: UserActor,
  message: { id: string; sourceId: string; providerMessageId: string; threadKey: string; from: string },
  mode: "other" | "archive",
  fetchImpl: typeof fetch = fetch,
) {
  const key = senderKey(message.from);
  if (!key) return;
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.mail_subscriptions (workspace_id, user_id, sender, cold_pitch_at) values ($1, $2, $3, now())
       on conflict (user_id, sender) do update set cold_pitch_at = coalesce(crm.mail_subscriptions.cold_pitch_at, now()), updated_at = now()`,
      [actor.workspaceId, actor.userId, key],
    );
    if (mode === "other") {
      await db.query(
        `insert into crm.mail_sender_rules (workspace_id, user_id, sender, split) values ($1, $2, $3, 'other')
         on conflict (user_id, sender) do nothing`,
        [actor.workspaceId, actor.userId, key],
      );
    }
  });
  if (mode === "archive") {
    await moveMessages(actor, message.sourceId, [{ id: message.id, providerMessageId: message.providerMessageId, threadKey: message.threadKey }], "archive", fetchImpl);
  }
}
