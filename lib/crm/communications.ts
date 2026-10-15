import { withActor } from "@/lib/crm/context";
import { createActivityInDb } from "@/lib/crm/activities";
import { readCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope, hasScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import type { Activity, Actor, Company, Contact, Task } from "@/lib/crm/types";

const RECENT_MS = 48 * 60 * 60 * 1000;

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
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

export type CommunicationInput = {
  kind: "email" | "meeting";
  title?: string | null;
  body?: string | null;
  occurredAt?: string | null;
  participantEmails?: string[];
  companyId?: string | null;
  contactId?: string | null;
};

export type CommunicationResult = {
  activity: Activity;
  company: Company | null;
  contacts: Contact[];
  task: Task | null;
  suggested: boolean;
};

export async function recordCommunication(
  actor: Actor,
  input: CommunicationInput,
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

  const result = await withActor(actor, async (db) => {
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
    let task: Task | null = null;
    let suggested = false;
    if (company && isRecent(activity.occurredAt) && hasScope(actor.scopes, "tasks:write")) {
      const open = await db.query<{ total: number }>(
        `select count(*)::int as total from crm.tasks
         where company_id = $1 and archived_at is null and completed_at is null`,
        [company.id],
      );
      if ((open.rows[0]?.total ?? 0) === 0) {
        const due = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        const who = contacts.find((contact) => contact.id === contactId)?.name || company.name;
        task = await createTaskInDb(
          db,
          actor,
          {
            title: `Follow up with ${who}`,
            description: `Suggested after a ${input.kind}.`,
            dueAt: due,
            companyId: company.id,
            contactId,
            priority: "normal",
          },
          { operation: "suggest_follow_up", source: "communication" },
        );
        suggested = true;
      }
    }

    return { activity, company, contacts, task, suggested };
  });
  if (result.task && actor.type === "user") {
    try {
      const { sendTaskToDefaultList } = await import("@/lib/crm/clickup");
      await sendTaskToDefaultList(actor, result.task.id);
    } catch (error) {
      console.error("Could not send the follow-up task to ClickUp", error);
    }
  }
  return result;
}
