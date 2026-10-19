"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import {
  createActivity,
  logActivity,
  type LoggedActivityType,
} from "@/lib/crm/activities";
import { actionError } from "@/lib/companies";
import { createTaskWithClickUp, pushClickUpTask } from "@/lib/crm/clickup";
import { createCompany } from "@/lib/crm/companies";
import { createContact, getContact, updateContact } from "@/lib/crm/contacts";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { isReminderMinutes } from "@/lib/crm/reminder-options";
import { completeTask, listDueReminders, updateTask, type DueReminder } from "@/lib/crm/tasks";
import type {
  Activity,
  ActivityType,
  Contact,
  Opportunity,
  OpportunityStatus,
  TaskPriority,
} from "@/lib/crm/types";
import { clickupToken } from "@/lib/clickup";
import { revalidateRecordPages } from "@/lib/revalidate";

export type RecordActionState = {
  error?: string;
  field?: string;
  existingId?: string;
  ok?: boolean;
  warning?: string;
};

export type ContactActionState = RecordActionState & { contact?: Contact };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function reminderField(value: string) {
  if (value === "" || value === "none") return null;
  const minutes = Number(value);
  return isReminderMinutes(minutes) ? minutes : Number.NaN;
}

function optionalId(value: string) {
  return value && value !== "none" && value !== "unassigned" ? value : null;
}

async function requestOrigin() {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!host) return null;
  return `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
}

function pushLater(user: Parameters<typeof pushClickUpTask>[0], id: string) {
  if (!clickupToken()) return;
  after(async () => {
    try {
      await pushClickUpTask(user, id);
    } catch (error) {
      console.error("ClickUp push failed", error);
    }
  });
}

function clickupWarning(error: string | null) {
  return error ? `Saved in Orbit, but ClickUp said: ${error} Orbit will try again.` : undefined;
}

function refresh() {
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/contacts");
  revalidatePath("/opportunities");
  revalidatePath("/boards", "layout");
  revalidatePath("/activities");
  revalidatePath(TASKS_PATH);
}

export async function saveContactAction(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
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
    tags: formData.has("tags")
      ? formData.getAll("tags").filter((value): value is string => typeof value === "string")
      : undefined,
  };
  try {
    const saved = id
      ? await updateContact(user, id, write, {
          provenance: { operation: "update_contact", source: "web" },
        })
      : await createContact(user, write, {
          provenance: { operation: "create_contact", source: "web" },
        });
    refresh();
    return { ok: true, contact: saved.body.contact };
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
    ...(id ? {} : { pipelineId: optionalId(text(formData, "pipelineId")) }),
    name: text(formData, "name"),
    stageId: optionalId(text(formData, "stageId")) ?? undefined,
    primaryContactId: optionalId(text(formData, "primaryContactId")),
    value: value ? value : null,
    currency: text(formData, "currency") || undefined,
    probability: probability ? Number(probability) : undefined,
    expectedCloseDate: text(formData, "expectedCloseDate") || null,
    status: (text(formData, "status") || undefined) as
      | OpportunityStatus
      | undefined,
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

export type InlineRecord = { id: string; name: string; company?: { id: string; name: string } | null };

function splitName(value: string) {
  const parts = value.trim().replace(/\s+/g, " ").split(" ");
  return { firstName: parts[0] || null, lastName: parts.slice(1).join(" ") || null };
}

export async function addCompanyInlineAction(input: { name: string; domain?: string }): Promise<{ company?: InlineRecord; error?: string }> {
  const user = await requireUser();
  try {
    const created = await createCompany(
      user,
      { name: input.name.trim(), domain: input.domain?.trim() || null, ownerId: user.userId },
      { provenance: { operation: "create_company", source: "web" } },
    );
    refresh();
    revalidatePath("/companies");
    return { company: { id: created.body.company.id, name: created.body.company.name } };
  } catch (error) {
    return actionError(error);
  }
}

export async function addContactInlineAction(input: {
  name: string;
  email?: string;
  companyId?: string | null;
}): Promise<{ contact?: InlineRecord; error?: string }> {
  const user = await requireUser();
  try {
    const created = await createContact(
      user,
      { ...splitName(input.name), email: input.email?.trim() || null, companyId: input.companyId || null, ownerId: user.userId },
      { provenance: { operation: "create_contact", source: "web" } },
    );
    refresh();
    const contact = created.body.contact;
    return {
      contact: {
        id: contact.id,
        name: contact.name,
        company: contact.companyId && contact.companyName ? { id: contact.companyId, name: contact.companyName } : null,
      },
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function addOpportunityInlineAction(input: {
  companyId: string;
  pipelineId: string | null;
  stageId: string | null;
  primaryContactId: string | null;
  name?: string;
  value?: string;
}): Promise<{ opportunity?: Opportunity; error?: string }> {
  const user = await requireUser();
  try {
    const created = await createOpportunity(
      user,
      {
        companyId: input.companyId,
        pipelineId: input.pipelineId,
        stageId: input.stageId ?? undefined,
        primaryContactId: input.primaryContactId,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.value?.trim() ? { value: input.value.trim() } : {}),
      },
      { provenance: { operation: "create_opportunity", source: "web" } },
    );
    refresh();
    return { opportunity: created.body.opportunity };
  } catch (error) {
    return actionError(error);
  }
}

export async function moveOpportunityStageAction(
  id: string,
  stageId: string,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await updateOpportunity(
      user,
      id,
      { stageId },
      { provenance: { operation: "move_opportunity", source: "web" } },
    );
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
    dueAt: due || null,
    remindMinutes: formData.has("remindMinutes")
      ? due
        ? reminderField(text(formData, "remindMinutes"))
        : null
      : undefined,
    priority: (text(formData, "priority") || "normal") as TaskPriority,
    companyId: optionalId(text(formData, "companyId")),
    contactId: optionalId(text(formData, "contactId")),
  };
  try {
    if (id) {
      await updateTask(user, id, write, {
        provenance: { operation: "update_task", source: "web" },
      });
      pushLater(user, id);
      refresh();
      return { ok: true };
    }
    const listId =
      formData.get("clickup") === "on" ? optionalId(text(formData, "clickupListId")) : null;
    const created = await createTaskWithClickUp(user, write, listId, {
      origin: await requestOrigin(),
      provenance: { operation: "create_task", source: "web" },
    });
    refresh();
    return { ok: true, warning: clickupWarning(created.clickupError) };
  } catch (error) {
    return actionError(error);
  }
}

export async function completeTaskAction(
  id: string,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await completeTask(user, id, {
      provenance: { operation: "complete_task", source: "web" },
    });
    pushLater(user, id);
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function addActivityAction(
  target: { companyId?: string | null; contactId?: string | null },
  type: LoggedActivityType,
  title: string,
  body: string,
): Promise<RecordActionState & { activity?: Activity }> {
  const user = await requireUser();
  try {
    const activity = await logActivity(user, target, type, title, body, {
      provenance: {
        operation: target.contactId
          ? "add_contact_activity"
          : "add_company_activity",
        source: "web",
      },
    });
    refresh();
    return { ok: true, activity };
  } catch (error) {
    return actionError(error);
  }
}

export async function addCompanyTaskAction(
  companyId: string,
  title: string,
  dueAt: string,
  clickupListId: string | null = null,
  remindMinutes: number | null = null,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    const created = await createTaskWithClickUp(
      user,
      {
        title,
        companyId,
        dueAt: dueAt.trim() || null,
        remindMinutes: dueAt.trim() ? remindMinutes : null,
      },
      clickupListId,
      {
        origin: await requestOrigin(),
        provenance: { operation: "create_task", source: "web" },
      },
    );
    refresh();
    return { ok: true, warning: clickupWarning(created.clickupError) };
  } catch (error) {
    return actionError(error);
  }
}

export async function linkCompanyContactAction(
  companyId: string,
  contactId: string,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await updateContact(
      user,
      contactId,
      { companyId },
      { provenance: { operation: "link_contact", source: "web" } },
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function unlinkCompanyContactAction(
  companyId: string,
  contactId: string,
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    const contact = await getContact(user, contactId);
    if (contact.companyId !== companyId) {
      refresh();
      return { ok: true };
    }
    await updateContact(
      user,
      contactId,
      { companyId: null },
      { provenance: { operation: "unlink_contact", source: "web" } },
    );
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function createCompanyContactAction(
  companyId: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    jobTitle: string;
  },
): Promise<RecordActionState & { contact?: Contact }> {
  const user = await requireUser();
  try {
    const created = await createContact(
      user,
      {
        companyId,
        firstName: input.firstName.trim() || null,
        lastName: input.lastName.trim() || null,
        email: input.email.trim() || null,
        phone: input.phone.trim() || null,
        jobTitle: input.jobTitle.trim() || null,
      },
      { provenance: { operation: "create_contact", source: "web" } },
    );
    refresh();
    return { ok: true, contact: created.body.contact };
  } catch (error) {
    return actionError(error);
  }
}

export async function dueRemindersAction(): Promise<DueReminder[]> {
  const user = await getUserActor();
  if (!user) return [];
  return listDueReminders(user);
}
