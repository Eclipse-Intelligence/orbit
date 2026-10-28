"use server";

import { revalidatePath } from "next/cache";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { archiveActivity, logActivity, type LoggedActivityType } from "@/lib/crm/activities";
import { actionError } from "@/lib/companies";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { createCompany } from "@/lib/crm/companies";
import { createContact, getContact, updateContact } from "@/lib/crm/contacts";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { TASKS_PATH } from "@/lib/crm/task-views";

import { completeTask, listDueReminders, type DueReminder } from "@/lib/crm/tasks";
import type { Activity, Contact, ContactWrite, Opportunity, OpportunityStatus, OpportunityWrite } from "@/lib/crm/types";
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

function optionalId(value: string) {
  return value && value !== "none" && value !== "unassigned" ? value : null;
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

function refresh() {
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/contacts");
  revalidatePath("/opportunities");
  revalidatePath("/boards", "layout");
  revalidatePath("/activities");
  revalidatePath(TASKS_PATH);
}

export async function patchContactAction(id: string, patch: ContactWrite): Promise<{ contact?: Contact; error?: string }> {
  const user = await requireUser();
  try {
    const result = await updateContact(user, id, patch, { provenance: { operation: "update_contact", source: "web" } });
    refresh();
    return { contact: result.body.contact };
  } catch (error) {
    return { error: actionError(error).error };
  }
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

type InlineRecord = { id: string; name: string; company?: { id: string; name: string } | null };

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

export type OpportunityPatch = Pick<
  OpportunityWrite,
  "name" | "value" | "currency" | "expectedCloseDate" | "primaryContactId" | "ownerId" | "source" | "probability" | "stageId" | "status"
>;

export async function patchOpportunityAction(
  id: string,
  patch: OpportunityPatch,
): Promise<{ opportunity?: Opportunity; error?: string }> {
  const user = await requireUser();
  try {
    const result = await updateOpportunity(user, id, patch, {
      provenance: { operation: "update_opportunity", source: "web" },
    });
    refresh();
    return { opportunity: result.body.opportunity };
  } catch (error) {
    return { error: actionError(error).error };
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

export async function archiveActivityAction(id: string): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await archiveActivity(user, id, { operation: "archive_activity", source: "web" });
    refresh();
    revalidatePath("/activities");
    return { ok: true };
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
