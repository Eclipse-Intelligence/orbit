import { createHash } from "node:crypto";
import { iso } from "@/lib/crm/mutate";
import type { CallBrief, PreparationBasis, PreparationKind, PreparedEmail, TaskPreparation } from "@/lib/crm/task-preparation";
import type { Task } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";

export type BasisParts = {
  opportunity: { id: string; stage: string | null; status: string; value: string | null } | null;
  lastActivity: { type: string; title: string | null; occurredAt: string } | null;
  lastEmailAt: string | null;
  threadLatest: string | null;
};

export type CurrentBasis = { basis: PreparationBasis; emailKnown: boolean };

type Extras = { contact_notes: string | null; company_description: string | null; probability: number | null; close_date: Date | string | null };

export async function currentBasisInDb(db: Db, task: Task, parts: BasisParts, emailKnown: boolean): Promise<CurrentBasis> {
  const extras = await db.query<Extras>(
    `select (select notes from crm.contacts where id = $1) as contact_notes,
       (select description from crm.companies where id = $2) as company_description,
       (select probability from crm.opportunities where id = $3) as probability,
       (select expected_close_date from crm.opportunities where id = $3) as close_date`,
    [task.contactId, task.companyId, parts.opportunity?.id ?? null],
  );
  const row = extras.rows[0];
  const closeDate = row?.close_date ? new Date(row.close_date).toISOString().slice(0, 10) : null;
  return {
    emailKnown,
    basis: {
      title: task.title,
      description: task.description?.trim() || null,
      dueDate: task.dueDate,
      contact: task.contactId
        ? {
            id: task.contactId,
            name: task.contactName ?? task.contactEmail ?? "Unnamed person",
            jobTitle: task.contactJobTitle,
            email: task.contactEmail,
            phone: task.contactPhone,
            notes: row?.contact_notes ?? null,
          }
        : null,
      company: task.companyId ? { id: task.companyId, name: task.companyName ?? "Unnamed company", description: row?.company_description ?? null } : null,
      opportunity: parts.opportunity
        ? { ...parts.opportunity, probability: row?.probability ?? null, closeDate }
        : null,
      lastActivity: parts.lastActivity,
      lastEmailAt: parts.lastEmailAt,
      threadLatest: parts.threadLatest,
    },
  };
}

export function basisFingerprint(basis: PreparationBasis) {
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

type PreparationRow = {
  kind: PreparationKind;
  content: Record<string, unknown> | null;
  basis: PreparationBasis | null;
  fingerprint: string | null;
  automatic: boolean;
  prepared_at: Date | string | null;
};

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function briefOf(content: Record<string, unknown>): CallBrief {
  return {
    who: text(content.who),
    lastContact: text(content.lastContact),
    stage: typeof content.stage === "string" && content.stage.trim() ? content.stage : null,
    openPoints: strings(content.openPoints),
    talkingPoints: strings(content.talkingPoints),
  };
}

function draftOf(content: Record<string, unknown>): PreparedEmail {
  const to = Array.isArray(content.to)
    ? content.to.flatMap((item) => {
        const person = item as { address?: unknown; name?: unknown } | null;
        return person && typeof person.address === "string" ? [{ address: person.address, name: typeof person.name === "string" ? person.name : null }] : [];
      })
    : [];
  return { to, subject: text(content.subject), body: text(content.body) };
}

export function isStale(stored: { fingerprint: string | null; basis: PreparationBasis | null }, current: CurrentBasis) {
  const compared = current.emailKnown ? current.basis : { ...current.basis, lastEmailAt: stored.basis?.lastEmailAt ?? null };
  return stored.fingerprint !== basisFingerprint(compared);
}

export async function readPreparationInDb(db: Db, userId: string, taskId: string, current: CurrentBasis): Promise<TaskPreparation | null> {
  const result = await db.query<PreparationRow>(
    `select kind, content, basis, fingerprint, automatic, prepared_at from crm.task_preparations
     where task_id = $1 and user_id = $2 and state = 'ready' and content is not null`,
    [taskId, userId],
  );
  const row = result.rows[0];
  if (!row?.content || !row.prepared_at) return null;
  return {
    kind: row.kind,
    brief: row.kind === "brief" ? briefOf(row.content) : null,
    draft: row.kind === "draft" ? draftOf(row.content) : null,
    preparedAt: iso(row.prepared_at) ?? new Date(0).toISOString(),
    automatic: row.automatic,
    stale: isStale(row, current),
    builtFrom: row.basis,
  };
}
