import { createHash } from "node:crypto";
import { iso } from "@/lib/crm/mutate";
import type { CallBrief, PreparationBasis, PreparationKind, PreparedEmail, TaskPreparation } from "@/lib/crm/task-preparation";
import type { Db } from "@/lib/db/pool";

type BasisSource = {
  task: { title: string; description: string | null };
  contact: { id: string; name: string; jobTitle: string | null; email: string | null; phone: string | null } | null;
  company: { id: string; name: string } | null;
  opportunity: { id: string; stage: string | null; status: string; value: string | null } | null;
  lastActivity: { type: string; title: string | null; occurredAt: string } | null;
  mail: { lastEmail: { at: string } | null; thread: { latest: string | null } | null } | null;
};

export function preparationBasis(detail: BasisSource): PreparationBasis {
  return {
    title: detail.task.title,
    description: detail.task.description ?? null,
    contact: detail.contact
      ? { id: detail.contact.id, name: detail.contact.name, jobTitle: detail.contact.jobTitle, email: detail.contact.email, phone: detail.contact.phone }
      : null,
    company: detail.company ? { id: detail.company.id, name: detail.company.name } : null,
    opportunity: detail.opportunity
      ? { id: detail.opportunity.id, stage: detail.opportunity.stage, status: detail.opportunity.status, value: detail.opportunity.value }
      : null,
    lastActivity: detail.lastActivity ? { type: detail.lastActivity.type, title: detail.lastActivity.title, occurredAt: detail.lastActivity.occurredAt } : null,
    lastEmailAt: detail.mail?.lastEmail?.at ?? null,
    threadLatest: detail.mail?.thread?.latest ?? null,
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

export async function readPreparationInDb(db: Db, userId: string, taskId: string, current: PreparationBasis | null): Promise<TaskPreparation | null> {
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
    stale: current ? row.fingerprint !== basisFingerprint(current) : false,
    builtFrom: row.basis,
  };
}
