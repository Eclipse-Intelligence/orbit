import { randomUUID } from "node:crypto";
import { saveBookingPage } from "@/lib/booking/pages";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { bookingUrl } from "@/lib/assistant/links";
import { saveBrandProfile } from "@/lib/crm/brand";
import { createCompany, updateCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { createOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { createProof } from "@/lib/crm/proof";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool } from "@/lib/db/pool";
import { appendToDailyNote } from "@/lib/docs/daily-notes";
import { createDoc, setAssistantCanEdit } from "@/lib/docs/store";
import { zonedParts, zonedTimeToDate } from "@/lib/time";
import { createUser } from "@/tests/helpers";
import type { Fixture, When, WorkspaceKey, WorkspaceSeed, World } from "./types";

const SEED = { operation: "eval_fixture", source: "web" as const };

function wallClock(when: When, now: Date) {
  const today = zonedParts(now);
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
  let offset: number;
  if ("days" in when) offset = when.days;
  else if ("nextWeek" in when) offset = ((1 - base.getUTCDay() + 7) % 7 || 7) + when.nextWeek;
  else offset = ((when.weekday - base.getUTCDay() + 7) % 7 || 7) + 7 * (when.weeks ?? 0);
  const day = new Date(base.getTime() + offset * 86_400_000);
  const [hour, minute] = (when.at ?? "09:00").split(":").map(Number);
  return { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute, second: 0 };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function londonDay(when: When, now = new Date()) {
  const wall = wallClock(when, now);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

function londonLocal(when: When, now = new Date()) {
  const wall = wallClock(when, now);
  return `${londonDay(when, now)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function londonInstant(when: When, now = new Date()) {
  return zonedTimeToDate(wallClock(when, now)).toISOString();
}

export function mergeFixtures(...fixtures: Fixture[]): Fixture {
  const merged: Fixture = {};
  for (const fixture of fixtures) {
    for (const key of ["eclipse", "ridgeon"] as const) {
      const seed = fixture[key];
      if (!seed) continue;
      const target: WorkspaceSeed = (merged[key] ??= {});
      for (const [field, value] of Object.entries(seed) as [keyof WorkspaceSeed, unknown][]) {
        if (Array.isArray(value)) (target as Record<string, unknown[]>)[field] = [...(((target as Record<string, unknown[]>)[field]) ?? []), ...value];
        else (target as Record<string, unknown>)[field] = value;
      }
    }
    if (fixture.web) merged.web = { ...merged.web, ...fixture.web };
    if (fixture.eclipseClients) merged.eclipseClients = [...(merged.eclipseClients ?? []), ...fixture.eclipseClients];
  }
  return merged;
}

type Box = { sourceId: string; folders: Record<"inbox" | "sent" | "archive", string> };

async function mailbox(actor: UserActor, email: string): Promise<Box> {
  const admin = getAdminPool();
  await saveMailbox(actor, { email, refreshToken: "eval-refresh", accessToken: "eval-access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const connection = await admin.query<{ id: string }>("select id from crm.mailbox_connections where workspace_id = $1 and user_id = $2 order by created_at desc limit 1", [
    actor.workspaceId,
    actor.userId,
  ]);
  const sourceId = (
    await admin.query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      actor.workspaceId,
      actor.userId,
      connection.rows[0].id,
      email,
    ])
  ).rows[0].id;
  const folder = async (role: string, name: string) =>
    (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $5, $6) returning id",
        [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, name, role],
      )
    ).rows[0].id;
  return { sourceId, folders: { inbox: await folder("inbox", "Inbox"), sent: await folder("sent", "Sent Items"), archive: await folder("archive", "Archive") } };
}

function inWorkspace(actor: UserActor, id: string, name: string): UserActor {
  return { ...actor, workspaceId: id, workspaceName: name, role: "owner", scopes: scopesForRole("owner") };
}

async function seedWorkspace(world: World, key: WorkspaceKey, seed: WorkspaceSeed, now: Date) {
  const actor = key === "eclipse" ? world.eclipse : world.ridgeon;
  const admin = getAdminPool();
  const ids = world.ids;
  const ref = (kind: string, name: string | undefined) => (name ? world.id(`${kind}:${name}`) : null);
  const myAddress = world.addresses[key];

  if (seed.brand) {
    await saveBrandProfile(actor, { website: seed.brand.website, whatYouSell: seed.brand.whatYouSell, whoItsFor: seed.brand.whoItsFor ?? "", tone: seed.brand.tone ?? "" }, SEED);
  }
  for (const company of seed.companies ?? []) {
    const created = await createCompany(
      actor,
      {
        name: company.name,
        domain: company.domain ?? null,
        website: company.domain ? `https://${company.domain}` : null,
        description: company.description ?? null,
        industry: company.industry ?? null,
        lifecycle: company.lifecycle ?? "prospect",
        tags: company.tags ?? null,
        ownerId: company.unowned ? null : actor.userId,
      },
      { provenance: SEED },
    );
    ids.set(`company:${company.name}`, created.body.company.id);
    if (company.domain) world.knownHosts.add(company.domain);
  }
  for (const contact of seed.contacts ?? []) {
    const created = await createContact(
      actor,
      {
        firstName: contact.first,
        lastName: contact.last,
        email: contact.email ?? null,
        jobTitle: contact.title ?? null,
        linkedinUrl: contact.linkedin ?? null,
        notes: contact.notes ?? null,
        companyId: ref("company", contact.company),
        ownerId: contact.unowned ? null : actor.userId,
      },
      { provenance: SEED },
    );
    ids.set(`contact:${contact.first} ${contact.last}`, created.body.contact.id);
    if (contact.email) world.knownAddresses.add(contact.email.toLowerCase());
    if (contact.linkedin) world.knownHosts.add(new URL(contact.linkedin).hostname.toLowerCase());
  }
  const stages = (await listPipeline(actor)).stages;
  for (const stage of stages) ids.set(`stage:${key}:${stage.name}`, stage.id);
  for (const deal of seed.deals ?? []) {
    const stage = stages.find((item) => item.name === deal.stage) ?? stages[0];
    const created = await createOpportunity(
      actor,
      {
        companyId: world.id(`company:${deal.company}`),
        name: deal.name,
        value: deal.value,
        currency: "GBP",
        stageId: stage.id,
        primaryContactId: ref("contact", deal.contact),
        expectedCloseDate: deal.close ? londonDay(deal.close, now) : null,
      },
      { provenance: SEED },
    );
    ids.set(`deal:${deal.name}`, created.body.opportunity.id);
  }
  for (const task of seed.tasks ?? []) {
    const created = await createTask(
      actor,
      {
        title: task.title,
        dueAt: task.due ? londonLocal(task.due, now) : null,
        remindMinutes: task.remindMinutes ?? null,
        companyId: ref("company", task.company),
        contactId: ref("contact", task.contact),
        completed: task.done ?? false,
      },
      { provenance: SEED },
    );
    ids.set(`task:${task.title}`, created.body.task.id);
  }
  for (const activity of seed.activities ?? []) {
    const row = await admin.query<{ id: string }>(
      `insert into crm.activities (workspace_id, type, title, body, occurred_at, company_id, contact_id, actor_user_id, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) returning id`,
      [
        actor.workspaceId,
        activity.type,
        activity.title,
        activity.body,
        londonInstant(activity.at, now),
        ref("company", activity.company),
        ref("contact", activity.contact),
        actor.userId,
        JSON.stringify(activity.transcript ? { source: "granola" } : {}),
      ],
    );
    if (activity.key) ids.set(`activity:${activity.key}`, row.rows[0].id);
    if (activity.transcript) {
      const insight = await admin.query<{ id: string }>(
        `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, summary, status)
         values ($1, $2, $3, $4, 'granola', $5, $6, 'ready') returning id`,
        [actor.workspaceId, row.rows[0].id, ref("contact", activity.contact), ref("company", activity.company), activity.transcript, activity.summary ?? null],
      );
      if (activity.key) ids.set(`insight:${activity.key}`, insight.rows[0].id);
    }
  }
  if ((seed.emails ?? []).length > 0 || (seed.events ?? []).length > 0) {
    const box = await mailbox(actor, myAddress);
    const me = { name: actor.fullName, email: myAddress };
    for (const email of seed.emails ?? []) {
      const from = email.from === "me" ? me : email.from;
      const to = email.to.map((person) => (person === "me" ? me : person));
      const at = londonInstant(email.at, now);
      const folder = email.folder ?? (email.from === "me" ? "sent" : "inbox");
      const row = await admin.query<{ id: string }>(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
           from_email, from_name, to_recipients, cc_recipients, sent_at, received_at, is_read)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $15, $16) returning id`,
        [
          actor.workspaceId,
          actor.userId,
          box.sourceId,
          box.folders[folder],
          `${email.key}-${world.tag}`,
          `<${email.key}.${world.tag}@mail.eval.test>`,
          email.thread ?? email.key,
          email.subject,
          email.body.slice(0, 200),
          email.body,
          from.email,
          from.name,
          JSON.stringify(to.map((person) => ({ name: person.name, address: person.email }))),
          JSON.stringify((email.cc ?? []).map((person) => ({ name: person.name, address: person.email }))),
          at,
          email.read ?? email.from === "me",
        ],
      );
      ids.set(`email:${email.key}`, row.rows[0].id);
      world.emailFrom.set(row.rows[0].id, from.email.toLowerCase());
    }
    if ((seed.events ?? []).length > 0) {
      const connection = await admin.query<{ id: string }>("select connection_id as id from crm.mail_sources where id = $1", [box.sourceId]);
      const calendar = await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, owner_email, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, $4, 'Calendar', '#3b82f6', $5, true, true, true, true) returning id`,
        [actor.workspaceId, actor.userId, connection.rows[0].id, `calendar-${world.tag}-${key}`, myAddress],
      );
      for (const event of seed.events ?? []) {
        const start = new Date(londonInstant(event.start, now));
        const organiser = event.organiser ?? me;
        const row = await admin.query<{ id: string }>(
          `insert into crm.calendar_events (workspace_id, connection_id, user_id, calendar_id, provider_event_id, ical_uid, subject, starts_at, ends_at, location, organizer, attendees, response_status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13) returning id`,
          [
            actor.workspaceId,
            connection.rows[0].id,
            actor.userId,
            calendar.rows[0].id,
            `${event.key}-${world.tag}`,
            `${event.key}-${world.tag}@calendar.eval.test`,
            event.subject,
            start.toISOString(),
            new Date(start.getTime() + event.minutes * 60_000).toISOString(),
            event.location ?? null,
            JSON.stringify({ name: organiser.name, email: organiser.email }),
            JSON.stringify([me, ...event.attendees].map((person) => ({ name: person.name, email: person.email, type: "required" }))),
            event.organiser ? "notResponded" : "organizer",
          ],
        );
        ids.set(`event:${event.key}`, row.rows[0].id);
      }
    }
  }
  for (const doc of seed.docs ?? []) {
    const author = doc.byColleague ? world.colleague : actor;
    const created = await createDoc(author, { title: doc.title, content: doc.content, shared: doc.shared ?? doc.byColleague ?? false }, SEED);
    if (doc.assistantCanEdit) await setAssistantCanEdit(author, created.id, true);
    ids.set(`doc:${doc.key ?? doc.title}`, created.id);
  }
  for (const daily of seed.daily ?? []) {
    const note = await appendToDailyNote(actor, { text: daily.text, date: londonDay(daily.day, now) }, SEED);
    ids.set(`daily:${note.date}`, note.page.id);
  }
  for (const item of seed.knowledge ?? []) {
    const row = await admin.query<{ id: string }>(
      `insert into crm.knowledge_items (workspace_id, scope, company_id, kind, title, status, summary, content, char_count, chunk_count, created_by_user_id, indexed_at)
       values ($1, $2, $3, 'file', $4, 'ready', $5, $6, $7, 1, $8, now()) returning id`,
      [actor.workspaceId, item.company ? "company" : "eclipse", ref("company", item.company), item.title, item.content.slice(0, 280), item.content, item.content.length, actor.userId],
    );
    await admin.query("insert into crm.knowledge_chunks (workspace_id, item_id, position, content) values ($1, $2, 0, $3)", [actor.workspaceId, row.rows[0].id, item.content]);
    ids.set(`knowledge:${item.title}`, row.rows[0].id);
  }
  for (const entry of seed.proof ?? []) {
    await createProof(actor, { client: entry.client, description: entry.description, result: entry.result, measured: entry.measured, product: entry.product ?? "", permission: "named" }, SEED);
  }
  for (const memory of seed.memories ?? []) {
    await admin.query(
      `insert into crm.memories (workspace_id, user_id, scope, kind, title, body, sources, confidence, origin, source)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'medium', 'learning', $8)`,
      [actor.workspaceId, memory.scope === "personal" ? actor.userId : null, memory.scope, memory.kind, memory.title, memory.body, JSON.stringify(memory.sources ?? []), fixtureSource(memory)],
    );
  }
  for (const change of seed.changes ?? []) {
    const companyId = world.id(`company:${change.company}`);
    await updateCompany(actor, companyId, { description: change.description }, { provenance: { operation: "update_company", source: "assistant" } });
    const event = await admin.query<{ id: string }>("select id from crm.audit_events where entity_id = $1 order by created_at desc, id desc limit 1", [companyId]);
    ids.set(`change:${change.company}`, event.rows[0].id);
  }
  if (seed.booking) {
    await saveBookingPage(actor, {
      slug: `mark-${world.tag}`,
      enabled: true,
      durationMinutes: 30,
      bufferMinutes: 10,
      minNoticeMinutes: 240,
      horizonDays: 21,
      weeklyHours: DEFAULT_WEEKLY_HOURS,
    });
    world.bookingUrl = bookingUrl(`mark-${world.tag}`);
  }
}

const WORLD_NAMES = ["Eclipse", "Mark Ridgeon"];

function fixtureSource(memory: { scope: string; sources?: unknown }) {
  const types = (Array.isArray(memory.sources) ? memory.sources : []).map((item) => String((item as { type?: unknown } | null)?.type ?? ""));
  if (memory.scope === "market" || types.includes("market_note")) return "market";
  for (const source of ["email", "call", "web"]) if (types.includes(source)) return source;
  return memory.scope === "personal" ? "chat" : "learned";
}

const WORLD_DATABASE = /^crm_(?:eval|test)(?:_[a-z0-9_]+)?$/;

async function retireEarlierWorlds(keep: string) {
  const admin = getAdminPool();
  const database = (await admin.query<{ name: string }>("select current_database() as name")).rows[0]?.name ?? "";
  if (!WORLD_DATABASE.test(database)) throw new Error(`Evaluation worlds only run in crm_eval or crm_test databases, not ${database || "(none)"}.`);
  await admin.query("update crm.workspace_brands set eclipse_client_id = null, eclipse_tools = false where eclipse_client_id is not null or eclipse_tools");
  await admin.query("delete from crm.integration_settings where integration = 'linear'");
  await admin.query("update crm.workspaces set name = name || ' ' || left(id::text, 8) where name = any($1::text[]) and id <> $2", [WORLD_NAMES, keep]);
}

async function linkBrands(eclipse: UserActor, ridgeon: UserActor, clients: { id: string; name: string }[]) {
  const admin = getAdminPool();
  const clientOf = (name: string) => clients.find((client) => client.name === name)?.id ?? null;
  await admin.query(
    `insert into crm.workspace_brands (workspace_id, eclipse_client_id, eclipse_tools) values ($1, $2, true), ($3, $4, false)
     on conflict (workspace_id) do update set eclipse_client_id = excluded.eclipse_client_id, eclipse_tools = excluded.eclipse_tools`,
    [eclipse.workspaceId, clientOf("Eclipse"), ridgeon.workspaceId, clientOf("Mark Ridgeon")],
  );
  await admin.query("insert into crm.integration_settings (integration, workspace_id, connected_by) values ('linear', $1, $2)", [eclipse.workspaceId, eclipse.userId]);
}

export async function buildWorld(fixture: Fixture, options: { workspace?: "eclipse" | "ridgeon"; now?: Date } = {}): Promise<World> {
  const now = options.now ?? new Date();
  const tag = randomUUID().slice(0, 8);
  const admin = getAdminPool();
  const addresses = { eclipse: `mark@eclipse-${tag}.test`, ridgeon: `mark@ridgeon-${tag}.test` };
  const mark = await createUser(addresses.eclipse, "Mark Ridgeon");
  await retireEarlierWorlds(mark.workspaceId);
  await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  const eclipse: UserActor = { ...mark, workspaceName: "Eclipse" };
  const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
  const ridgeon = inWorkspace(eclipse, created.id, "Mark Ridgeon");
  await linkBrands(eclipse, ridgeon, fixture.eclipseClients ?? []);
  const colleagueEmail = `tamsin@eclipse-${tag}.test`;
  const colleagueId = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', 'Tamsin Holt') as id", [colleagueEmail])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [eclipse.workspaceId, colleagueId]);
  const colleague: UserActor = { ...eclipse, userId: colleagueId, email: colleagueEmail, fullName: "Tamsin Holt", role: "member", scopes: scopesForRole("member") };
  const ids = new Map<string, string>([
    ["workspace:eclipse", eclipse.workspaceId],
    ["workspace:ridgeon", ridgeon.workspaceId],
    ["user:me", eclipse.userId],
  ]);
  const world: World = {
    tag,
    eclipse,
    ridgeon,
    colleague,
    actor: options.workspace === "ridgeon" ? ridgeon : eclipse,
    ids,
    addresses,
    bookingUrl: null,
    web: new Map(Object.entries(fixture.web ?? {}).map(([url, html]) => [normalUrl(url), html])),
    eclipseClients: fixture.eclipseClients ?? [],
    knownHosts: new Set(),
    knownAddresses: new Set([addresses.eclipse, addresses.ridgeon, colleagueEmail]),
    emailFrom: new Map(),
    dns: new Map(Object.entries(fixture.dns ?? {}).map(([host, address]) => [host.toLowerCase(), address])),
    id: (key: string) => {
      const found = ids.get(key);
      if (!found) throw new Error(`The fixture has no ${key}.`);
      return found;
    },
  };
  if (fixture.eclipse) await seedWorkspace(world, "eclipse", fixture.eclipse, now);
  if (fixture.ridgeon) await seedWorkspace(world, "ridgeon", fixture.ridgeon, now);
  return world;
}

export function normalUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

export function fill(template: string, world: World) {
  return template.replace(/\{\{(\w+):([^}]+)\}\}/g, (_match, kind: string, name: string) => {
    if (kind === "id") return world.id(name);
    if (kind === "booking") return world.bookingUrl ?? "";
    const id = world.id(`${kind}:${name}`);
    return `@[${name}](${kind}:${id})`;
  });
}
