"use server";

import { revalidatePath } from "next/cache";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { getUserActor } from "@/lib/auth/user";
import { archiveActivity, logActivity, updateActivity, type LoggedActivityType } from "@/lib/crm/activities";
import type { ActivityEdit } from "@/lib/crm/activity-edit";
import { actionError } from "@/lib/companies";
import { snoozeTask } from "@/lib/crm/action-needed";
import { pushClickUpTask } from "@/lib/crm/clickup";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import { createContact, findContactsToLink, getContact, updateContact } from "@/lib/crm/contacts";
import { mergeContacts } from "@/lib/crm/merge";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { createOpportunity, listOpportunities, updateOpportunity } from "@/lib/crm/opportunities";
import { opportunityWriteFromForm } from "@/lib/crm/opportunity-form";
import { linkTask, taskLinkCandidates, type LinkCandidates } from "@/lib/crm/task-links";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { TASK_LOOKUP_FAILED, taskActorOrError } from "@/lib/crm/workspaces";

import { completeTask, getTask, listDueReminders, placeTask, reopenTask, TASK_PLACE_FAILED, updateTask, type DueReminder, type TaskPlacement } from "@/lib/crm/tasks";
import type { Activity, Contact, ContactWrite, Opportunity, OpportunityWrite } from "@/lib/crm/types";
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

async function taskUser(id: unknown) {
  return (await taskActorOrError(await requireUser(), id)).actor ?? null;
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
  revalidatePath(SETTINGS_PATHS.activity);
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

export async function mergeContactAction(keepId: string, mergeId: string): Promise<{ error?: string; keptId?: string }> {
  const user = await requireUser();
  try {
    const result = await mergeContacts(user, keepId, mergeId, { operation: "merge_contacts", source: "web" });
    refresh();
    return { keptId: result.kept.id };
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
    location: formData.has("location") ? text(formData, "location") || null : undefined,
    salesNavigatorUrl: formData.has("salesNavigatorUrl") ? text(formData, "salesNavigatorUrl") || null : undefined,
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
  const write = opportunityWriteFromForm(formData);
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
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
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

export async function reopenTaskAction(id: string): Promise<RecordActionState> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id)) return { error: "Couldn't undo. Try again." };
  try {
    await reopenTask(user, id, { provenance: { operation: "reopen_task", source: "web" } });
    pushLater(user, id);
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function openTaskIdsAction(ids: string[]): Promise<{ open?: string[]; error?: string }> {
  const user = await requireUser();
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && isUuid(id)))].slice(0, 50);
  const open: string[] = [];
  for (const id of wanted) {
    const resolved = await taskActorOrError(user, id);
    if (!resolved.actor) continue;
    const task = await getTask(resolved.actor, id).catch(() => null);
    if (task && !task.completedAt && !task.archivedAt) open.push(id);
  }
  return { open };
}

export async function remindTaskAction(id: string, at: string): Promise<RecordActionState & { saved?: { dueAt: string | null; dueHasTime: boolean } }> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id) || typeof at !== "string") return { error: "Couldn't move the task. Try again." };
  try {
    const moved = await snoozeTask(user, id, at);
    pushLater(user, id);
    refresh();
    return { ok: true, saved: { dueAt: moved.body.task.dueAt, dueHasTime: moved.body.task.dueHasTime } };
  } catch (error) {
    return actionError(error);
  }
}

export async function placeTaskAction(id: string, placement: TaskPlacement): Promise<RecordActionState> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id) || !placement || typeof placement !== "object") return { error: TASK_PLACE_FAILED };
  const write: TaskPlacement =
    placement.dateOnly === true ? { dateOnly: true } : { at: String(placement.at), durationMinutes: Number(placement.durationMinutes) };
  try {
    const placed = await placeTask(user, id, write, { provenance: { operation: "drag_task", source: "web" } });
    if (!placed.changed) return { ok: true };
    pushLater(user, id);
    refresh();
    revalidatePath("/calendar");
    return { ok: true };
  } catch (error) {
    return error instanceof CrmError ? actionError(error) : { error: TASK_PLACE_FAILED };
  }
}

export async function assignTaskAction(id: string, ownerId: string): Promise<RecordActionState> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id) || !isUuid(ownerId)) return { error: "Couldn't assign the task. Try again." };
  try {
    await updateTask(user, id, { ownerId }, { provenance: { operation: "assign_task", source: "web" } });
    pushLater(user, id);
    refresh();
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function taskLinkCandidatesAction(id: string): Promise<Partial<LinkCandidates> & { error?: string }> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id)) return { error: "Couldn't find people to link. Try again." };
  try {
    return await taskLinkCandidates(user, id);
  } catch (error) {
    return actionError(error);
  }
}

export async function searchTaskLinkTargetsAction(id: string, query: string) {
  const user = await taskUser(id);
  if (!user) return { contacts: [], companies: [], error: TASK_LOOKUP_FAILED };
  const text = typeof query === "string" ? query.trim().slice(0, 200) : "";
  if (!text) return { contacts: [], companies: [] };
  const [contacts, companies] = await Promise.all([
    findContactsToLink(user, null, text, 8),
    listCompanies(user, { query: text, limit: 20, sort: "name", order: "asc" }).then((result) => result.data),
  ]);
  return { contacts, companies };
}

export async function linkTaskAction(id: string, link: { contactId?: string; companyId?: string }): Promise<RecordActionState> {
  const user = await taskUser(id);
  if (!user) return { error: TASK_LOOKUP_FAILED };
  if (!isUuid(id)) return { error: "Couldn't link the task. Try again." };
  try {
    await linkTask(user, id, { contactId: link?.contactId, companyId: link?.companyId }, { operation: "link_task", source: "web" });
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
    revalidatePath(SETTINGS_PATHS.activity);
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function updateActivityAction(id: string, edit: ActivityEdit): Promise<RecordActionState & { activity?: Activity }> {
  const user = await requireUser();
  try {
    const result = await updateActivity(user, id, edit, { operation: "update_activity", source: "web" });
    refresh();
    revalidatePath(SETTINGS_PATHS.activity);
    return { ok: true, activity: result.activity };
  } catch (error) {
    return actionError(error);
  }
}

export async function companyOpportunitiesAction(companyId: string): Promise<{ opportunities: { id: string; name: string }[]; error?: string }> {
  const user = await requireUser();
  if (!isUuid(companyId)) return { opportunities: [] };
  try {
    const listed = await listOpportunities(user, { companyId, limit: 100 });
    return {
      opportunities: listed.data.map((opportunity) => ({
        id: opportunity.id,
        name: opportunity.pipelineKind === "board" && opportunity.pipelineName ? `${opportunity.name} (${opportunity.pipelineName})` : opportunity.name,
      })),
    };
  } catch (error) {
    return { opportunities: [], error: actionError(error).error };
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
