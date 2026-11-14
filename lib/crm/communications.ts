import { withActor } from "@/lib/crm/context";
import { createActivityInDb } from "@/lib/crm/activities";
import { readCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope, hasScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import { scheduleTaskDue, withDueNote } from "@/lib/crm/task-due";
import type { Activity, Actor, Company, Contact, Task } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { followUpTitle, USER_WAIT_TITLE_MS } from "@/lib/mail/follow-up-title";

const RECENT_MS = 48 * 60 * 60 * 1000;

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.co.uk",
  "outlook.fr",
  "outlook.de",
  "outlook.ie",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "live.com",
  "live.co.uk",
  "live.fr",
  "live.de",
  "live.ie",
  "msn.com",
  "windowslive.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.ie",
  "yahoo.it",
  "yahoo.es",
  "ymail.com",
  "rocketmail.com",
  "btinternet.com",
  "btopenworld.com",
  "talk21.com",
  "sky.com",
  "virginmedia.com",
  "virgin.net",
  "ntlworld.com",
  "blueyonder.co.uk",
  "talktalk.net",
  "tiscali.co.uk",
  "plus.com",
  "freeserve.co.uk",
  "orange.fr",
  "wanadoo.fr",
  "wanadoo.co.uk",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "t-online.de",
  "freenet.de",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "aol.co.uk",
  "aim.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.co.uk",
  "gmx.fr",
  "web.de",
  "mail.com",
  "email.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "tutanota.com",
  "tuta.io",
  "qq.com",
  "163.com",
  "hushmail.com",
]);

export function isFreeMailDomain(domain: string) {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

export function isRecent(at: string | null | undefined) {
  if (!at) return false;
  const time = new Date(at).getTime();
  if (Number.isNaN(time)) return false;
  const age = Date.now() - time;
  return age <= RECENT_MS && age >= -5 * 60 * 1000;
}

export async function companyHasOpenTask(workspaceId: string, companyId: string) {
  const result = await query<{ open: boolean }>("select private.company_has_open_task($1, $2) as open", [workspaceId, companyId]);
  return result.rows[0]?.open === true;
}

type CommunicationInput = {
  kind: "email" | "meeting";
  title?: string | null;
  body?: string | null;
  occurredAt?: string | null;
  participantEmails?: string[];
  companyId?: string | null;
  contactId?: string | null;
};

type CommunicationResult = {
  activity: Activity;
  company: Company | null;
  contacts: Contact[];
  task: Task | null;
  suggested: boolean;
};

export async function recordCommunication(
  actor: Actor,
  input: CommunicationInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CommunicationResult> {
  assertScope(actor.scopes, "activities:write");
  const title = input.title?.trim() || null;
  const body = input.body?.trim() || null;
  if (!title && !body) {
    throw new CrmError("invalid_input", "Add a subject or a note about what was discussed.", 400, {
      field: "body",
    });
  }
  const emails = [...new Set((input.participantEmails ?? []).map((email) => canonicalEmail(email)).filter(Boolean))] as string[];

  const recorded = await withActor(actor, async (db) => {
    const contacts: Contact[] = [];
    for (const email of emails) {
      const found = await db.query<{ id: string }>(
        `select id from crm.contacts
         where workspace_id = $1 and archived_at is null and normalized_email = $2
         limit 1`,
        [actor.workspaceId, email],
      );
      if (!found.rows[0]) continue;
      const contact = await readContactInDb(db, found.rows[0].id, actor.workspaceId);
      if (contact) contacts.push(contact);
    }

    let companyId = input.companyId ?? null;
    const participant = companyId
      ? contacts.find((contact) => contact.companyId === companyId || contact.companyId === null)
      : contacts[0];
    const contactId = input.contactId ?? participant?.id ?? null;
    if (!companyId) companyId = contacts.find((contact) => contact.companyId)?.companyId ?? null;
    if (!companyId) {
      for (const email of emails) {
        const domain = canonicalDomain(email.split("@")[1] ?? "");
        if (!domain || isFreeMailDomain(domain)) continue;
        const company = await db.query<{ id: string }>(
          `select id from crm.companies
           where workspace_id = $1 and archived_at is null and domain = $2
           limit 1`,
          [actor.workspaceId, domain],
        );
        if (company.rows[0]) {
          companyId = company.rows[0].id;
          break;
        }
      }
    }

    const activity = await createActivityInDb(
      db,
      actor,
      {
        type: input.kind,
        title,
        body,
        occurredAt: input.occurredAt,
        companyId,
        contactId,
        metadata: emails.length > 0 ? { participants: emails } : null,
      },
      { operation: input.kind === "email" ? "record_email" : "record_meeting", source: "communication" },
    );

    const company = companyId ? await readCompanyInDb(db, companyId, actor.workspaceId) : null;
    const followUp =
      company && isRecent(activity.occurredAt) && hasScope(actor.scopes, "tasks:write") && !(await companyHasOpenTask(actor.workspaceId, company.id))
        ? { who: contacts.find((contact) => contact.id === contactId)?.name || company.name, companyId: company.id, contactId }
        : null;
    return { activity, company, contacts, followUp };
  });

  const { followUp, ...filed } = recorded;
  if (!followUp) return { ...filed, task: null, suggested: false };
  const task = await suggestFollowUp(actor, input.kind, followUp, { title, body }, options);
  if (task && actor.type === "user") {
    try {
      const { sendTaskToDefaultList } = await import("@/lib/crm/clickup");
      await sendTaskToDefaultList(actor, task.id);
    } catch (error) {
      console.error("Could not send the follow-up task to ClickUp", error);
    }
  }
  return { ...filed, task, suggested: task !== null };
}

async function suggestFollowUp(
  actor: Actor,
  kind: CommunicationInput["kind"],
  followUp: { who: string; companyId: string; contactId: string | null },
  email: { title: string | null; body: string | null },
  options: { fetchImpl?: typeof fetch },
) {
  try {
    const title =
      kind === "email"
        ? await followUpTitle(
            { who: followUp.who, subject: email.title, text: email.body },
            { logged: true, timeoutMs: USER_WAIT_TITLE_MS, fetchImpl: options.fetchImpl },
          )
        : `Follow up with ${followUp.who}`;
    const due = await scheduleTaskDue(actor, { days: 2 });
    return await withActor(actor, async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`follow-up|${actor.workspaceId}|${followUp.companyId}`]);
      if (await companyHasOpenTask(actor.workspaceId, followUp.companyId)) return null;
      return createTaskInDb(
        db,
        actor,
        {
          title: title.slice(0, 200),
          description: withDueNote(kind === "email" ? "Suggested after an email." : "Suggested after a meeting.", due),
          dueDate: due?.dueDate ?? null,
          companyId: followUp.companyId,
          contactId: followUp.contactId,
          priority: "normal",
        },
        { operation: "suggest_follow_up", source: "communication" },
      );
    });
  } catch (error) {
    console.error("Could not suggest a follow-up task", error);
    return null;
  }
}
