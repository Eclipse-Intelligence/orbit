"use server";

import { revalidatePath } from "next/cache";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { createCompanyView, deleteCompanyView, updateCompanyView } from "@/lib/crm/company-views";
import { companyHref } from "@/lib/crm/hrefs";
import { getAnswer, markCompanyDue, setManualAnswer, revertToWebAnswer } from "@/lib/ai-fields/answers";
import {
  aiFieldEditImpact,
  checkFieldAgain,
  publicField,
  removeAiField,
  saveAiField,
  scopeCounts,
  setAiFieldHidden,
  setAiFieldPaused,
  showRuleAsColumn,
  type AiFieldInput,
} from "@/lib/ai-fields/fields";
import { checkCompanyNow, checkNowMessage, kickAiFields } from "@/lib/ai-fields/runner";
import type { AiAnswer, AiField, CompanyView } from "@/lib/ai-fields/types";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

type Failure = { error: string; field?: string };

function failure(error: unknown, fallback: string): Failure {
  if (error instanceof CrmError) return { error: error.message, field: typeof error.details?.field === "string" ? error.details.field : undefined };
  console.error(fallback, error);
  return { error: fallback };
}

function refreshLists() {
  revalidatePath("/");
  revalidatePath(SETTINGS_PATHS.aiFields);
}

async function signedIn() {
  const user = await getUserActor();
  if (!user) throw new CrmError("unauthorized", "Sign in again.", 401);
  return user;
}

export async function saveAiFieldAction(input: AiFieldInput & { fill?: boolean }): Promise<{ field: AiField } | Failure> {
  try {
    const user = await signedIn();
    const field = await saveAiField(user, input);
    if (input.fill !== false) kickAiFields(user, { fieldIds: [field.id] });
    refreshLists();
    return { field: publicField(field) };
  } catch (error) {
    return failure(error, "Couldn't save the AI field. Try again.");
  }
}

export async function removeAiFieldAction(id: string): Promise<{ ok: true } | Failure> {
  try {
    await removeAiField(await signedIn(), id);
    refreshLists();
    return { ok: true };
  } catch (error) {
    return failure(error, "Couldn't delete the AI field. Try again.");
  }
}

export async function setAiFieldPausedAction(id: string, paused: boolean): Promise<{ ok: true } | Failure> {
  try {
    const user = await signedIn();
    await setAiFieldPaused(user, id, paused);
    if (!paused) kickAiFields(user, { fieldIds: [id] });
    refreshLists();
    return { ok: true };
  } catch (error) {
    return failure(error, "Couldn't change the AI field. Try again.");
  }
}

export async function checkFieldAgainAction(id: string): Promise<{ ok: true } | Failure> {
  try {
    const user = await signedIn();
    await checkFieldAgain(user, id);
    kickAiFields(user, { fieldIds: [id] });
    refreshLists();
    return { ok: true };
  } catch (error) {
    return failure(error, "Couldn't start the checks. Try again.");
  }
}

export async function showRuleAsColumnAction(webCheckId: string): Promise<{ field: AiField } | Failure> {
  try {
    const user = await signedIn();
    const field = await showRuleAsColumn(user, webCheckId);
    kickAiFields(user, { fieldIds: [field.id] });
    refreshLists();
    return { field: publicField(field) };
  } catch (error) {
    return failure(error, "Couldn't add the column. Try again.");
  }
}

export async function setAiFieldHiddenAction(fieldId: string, hidden: boolean): Promise<{ ok: true } | Failure> {
  try {
    await setAiFieldHidden(await signedIn(), fieldId, hidden);
    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    return failure(error, "Couldn't change the column. Try again.");
  }
}

export async function aiFieldScopeCountsAction(): Promise<{ all: number; fit: number; views: Record<string, number> } | Failure> {
  try {
    return await scopeCounts(await signedIn());
  } catch (error) {
    return failure(error, "Couldn't count companies.");
  }
}

export async function aiFieldEditImpactAction(fieldId: string): Promise<{ web: number; manual: number } | Failure> {
  try {
    return await aiFieldEditImpact(await signedIn(), fieldId);
  } catch (error) {
    return failure(error, "Couldn't count the answers.");
  }
}

export async function getAnswerAction(fieldId: string, companyId: string): Promise<{ answer: AiAnswer } | Failure> {
  try {
    const { answer } = await getAnswer(await signedIn(), fieldId, companyId);
    return { answer };
  } catch (error) {
    return failure(error, "Couldn't load the answer.");
  }
}

export async function setManualAnswerAction(fieldId: string, companyId: string, value: unknown): Promise<{ answer: AiAnswer } | Failure> {
  try {
    const { answer } = await setManualAnswer(await signedIn(), fieldId, companyId, value);
    revalidatePath("/");
    revalidatePath(companyHref(companyId));
    return { answer };
  } catch (error) {
    return failure(error, "Couldn't save the answer. Try again.");
  }
}

export async function restoreWebAnswerAction(fieldId: string, companyId: string): Promise<{ answer: AiAnswer } | Failure> {
  try {
    const user = await signedIn();
    const { answer } = await revertToWebAnswer(user, fieldId, companyId);
    if (answer.state === "checking") kickAiFields(user, { companyId, fieldIds: [fieldId] });
    revalidatePath("/");
    revalidatePath(companyHref(companyId));
    return { answer };
  } catch (error) {
    return failure(error, "Couldn't switch back to the web answer. Try again.");
  }
}

export async function checkCompanyAgainAction(companyId: string, fieldIds?: string[]): Promise<{ ok: true; message: string } | Failure> {
  try {
    const user = await signedIn();
    await markCompanyDue(user, companyId, fieldIds);
    const report = await checkCompanyNow(user, companyId, { fieldIds });
    revalidatePath("/");
    revalidatePath(companyHref(companyId));
    return checkNowMessage(report);
  } catch (error) {
    return failure(error, "Couldn't check again. Try again.");
  }
}

export async function createCompanyViewAction(name: string, params: string): Promise<{ view: CompanyView } | Failure> {
  try {
    const view = await createCompanyView(await signedIn(), { name, params });
    refreshLists();
    return { view };
  } catch (error) {
    return failure(error, "Couldn't save the view. Try again.");
  }
}

export async function updateCompanyViewAction(id: string, input: { name?: string; params?: string }): Promise<{ view: CompanyView } | Failure> {
  try {
    const view = await updateCompanyView(await signedIn(), id, input);
    refreshLists();
    return { view };
  } catch (error) {
    return failure(error, "Couldn't change the view. Try again.");
  }
}

export async function deleteCompanyViewAction(id: string): Promise<{ ok: true } | Failure> {
  try {
    await deleteCompanyView(await signedIn(), id);
    refreshLists();
    return { ok: true };
  } catch (error) {
    return failure(error, "Couldn't delete the view. Try again.");
  }
}
