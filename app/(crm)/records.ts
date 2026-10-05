"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { createActivity } from "@/lib/crm/activities";
import { actionError } from "@/lib/companies";
import { createContact, updateContact } from "@/lib/crm/contacts";
import {
  createOpportunity,
  updateOpportunity,
} from "@/lib/crm/opportunities";
import { completeTask, createTask, updateTask } from "@/lib/crm/tasks";
import type { ActivityType, OpportunityStatus, TaskPriority } from "@/lib/crm/types";

export type RecordActionState = {
  error?: string;
  field?: string;
  ok?: boolean;
};

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalId(value: string) {
  return value && value !== "none" && value !== "unassigned" ? value : null;
}

function refresh() {
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/opportunities");
  revalidatePath("/activities");
  revalidatePath("/actions");
}

export async function saveContactAction(
  _state: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  const user = await requireUser();
  const id = text(formData, "id");
  const write = {
    firstName: text(formData, "firstName") || null,
    lastName: text(formData, "lastName") || null,
    email: text(formData, "email") || null,
    phone: text(formData, "phone") || null,
    jobTitle: text(formData, "jobTitle") || null,
    linkedinUrl: text(formData, "linkedinUrl") || null,
    companyId: optionalId(text(formData, "companyId")),
    ownerId: optionalId(text(formData, "ownerId")),
    source: text(formData, "source") || null,
    notes: text(formData, "notes") || null,
  };
  try {
    if (id) await updateContact(user, id, write, { provenance: { operation: "update_contact", source: "web" } });
    else await createContact(user, write, { provenance: { operation: "create_contact", source: "web" } });
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function saveOpportunityAction(
  _state: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  const user = await requireUser();
  const id = text(formData, "id");
  const value = text(formData, "value");
  const probability = text(formData, "probability");
  const write = {
    companyId: text(formData, "companyId"),
    name: text(formData, "name"),
    stageId: optionalId(text(formData, "stageId")) ?? undefined,
    primaryContactId: optionalId(text(formData, "primaryContactId")),
    value: value ? value : null,
    currency: text(formData, "currency") || undefined,
    probability: probability ? Number(probability) : null,
    expectedCloseDate: text(formData, "expectedCloseDate") || null,
    status: (text(formData, "status") || undefined) as OpportunityStatus | undefined,
    source: text(formData, "source") || null,
  };
  try {
    if (id) {
      await updateOpportunity(user, id, write, {
        provenance: { operation: "update_opportunity", source: "web" },
      });
    } else {
      await createOpportunity(user, write, {
        provenance: { operation: "create_opportunity", source: "web" },
      });
    }
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function saveActivityAction(
  _state: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await createActivity(
      user,
      {
        type: (text(formData, "type") || "note") as ActivityType,
        title: text(formData, "title") || null,
        body: text(formData, "body") || null,
        occurredAt: text(formData, "occurredAt") || null,
        companyId: optionalId(text(formData, "companyId")),
        contactId: optionalId(text(formData, "contactId")),
      },
      { provenance: { operation: "create_activity", source: "web" } },
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function saveTaskAction(
  _state: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  const user = await requireUser();
  const id = text(formData, "id");
  const due = text(formData, "dueAt");
  const write = {
    title: text(formData, "title"),
    description: text(formData, "description") || null,
    dueAt: due ? new Date(due).toISOString() : null,
    priority: (text(formData, "priority") || "normal") as TaskPriority,
    companyId: optionalId(text(formData, "companyId")),
    contactId: optionalId(text(formData, "contactId")),
  };
  try {
    if (id) await updateTask(user, id, write, { provenance: { operation: "update_task", source: "web" } });
    else await createTask(user, write, { provenance: { operation: "create_task", source: "web" } });
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function completeTaskAction(id: string): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await completeTask(user, id, { provenance: { operation: "complete_task", source: "web" } });
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function addCompanyNoteAction(companyId: string, body: string): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await createActivity(
      user,
      { type: "note", body, companyId },
      { provenance: { operation: "add_note", source: "web" } },
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function addCompanyTaskAction(
  companyId: string,
  title: string,
  dueAt: string,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await createTask(
      user,
      {
        title,
        companyId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      },
      { provenance: { operation: "create_task", source: "web" } },
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
