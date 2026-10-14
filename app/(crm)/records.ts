"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import {
  createActivity,
  logActivity,
  type LoggedActivityType,
} from "@/lib/crm/activities";
import { actionError } from "@/lib/companies";
import { createContact, getContact, updateContact } from "@/lib/crm/contacts";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { completeTask, createTask, updateTask } from "@/lib/crm/tasks";
import type {
  Activity,
  ActivityType,
  Contact,
  OpportunityStatus,
  TaskPriority,
} from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export type RecordActionState = {
  error?: string;
  field?: string;
  ok?: boolean;
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

function refresh() {
  revalidatePath("/");
  revalidateRecordPages();
  revalidatePath("/contacts");
  revalidatePath("/opportunities");
  revalidatePath("/activities");
  revalidatePath("/actions");
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
    priority: (text(formData, "priority") || "normal") as TaskPriority,
    companyId: optionalId(text(formData, "companyId")),
    contactId: optionalId(text(formData, "contactId")),
  };
  try {
    if (id)
      await updateTask(user, id, write, {
        provenance: { operation: "update_task", source: "web" },
      });
    else
      await createTask(user, write, {
        provenance: { operation: "create_task", source: "web" },
      });
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
): Promise<RecordActionState> {
  const user = await requireUser();
  try {
    await createTask(
      user,
      {
        title,
        companyId,
        dueAt: dueAt.trim() || null,
      },
      { provenance: { operation: "create_task", source: "web" } },
    );
    refresh();
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
