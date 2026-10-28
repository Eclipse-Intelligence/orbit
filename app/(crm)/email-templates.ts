"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import {
  createEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  listEmailTemplates,
  updateEmailTemplate,
  type EmailTemplate,
  type EmailTemplateWrite,
} from "@/lib/crm/email-templates";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export type TemplateResult = { template: EmailTemplate } | { error: string };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function refresh() {
  revalidatePath(SETTINGS_PATHS.emailTemplates);
}

function failure(error: unknown, fallback: string) {
  return { error: error instanceof CrmError ? error.message : fallback };
}

export async function listEmailTemplatesAction(): Promise<
  { templates: EmailTemplate[] } | { error: string }
> {
  const user = await requireUser();
  try {
    return { templates: await listEmailTemplates(user) };
  } catch (error) {
    return failure(error, "Could not load your templates.");
  }
}

export async function createEmailTemplateAction(
  input: EmailTemplateWrite,
): Promise<TemplateResult> {
  const user = await requireUser();
  try {
    const template = await createEmailTemplate(user, input, { operation: "create_email_template", source: "web" });
    refresh();
    return { template };
  } catch (error) {
    return failure(error, "Could not save the template.");
  }
}

export async function updateEmailTemplateAction(
  id: string,
  input: EmailTemplateWrite,
): Promise<TemplateResult> {
  const user = await requireUser();
  try {
    const template = await updateEmailTemplate(user, id, input, { operation: "update_email_template", source: "web" });
    refresh();
    return { template };
  } catch (error) {
    return failure(error, "Could not save the template.");
  }
}

export async function duplicateEmailTemplateAction(
  id: string,
): Promise<TemplateResult> {
  const user = await requireUser();
  try {
    const template = await duplicateEmailTemplate(user, id, { operation: "duplicate_email_template", source: "web" });
    refresh();
    return { template };
  } catch (error) {
    return failure(error, "Could not duplicate the template.");
  }
}

export async function deleteEmailTemplateAction(
  id: string,
): Promise<{ id: string } | { error: string }> {
  const user = await requireUser();
  try {
    const result = await deleteEmailTemplate(user, id, { operation: "delete_email_template", source: "web" });
    refresh();
    return result;
  } catch (error) {
    return failure(error, "Could not delete the template.");
  }
}
