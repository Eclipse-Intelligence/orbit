"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, supabaseConfigured } from "@/lib/auth/config";
import { createSupabaseServer } from "@/lib/auth/supabase";
import { getUserActor } from "@/lib/auth/user";
import { companiesCsvRows, actionError } from "@/lib/companies";
import {
  archiveCompany,
  createCompany,
  listCompanies,
  updateCompany,
} from "@/lib/crm/companies";
import { mergeCompanies } from "@/lib/crm/merge";
import type { AccountHealth, Company, CompanyListQuery, CompanyWrite, LifecycleCount } from "@/lib/crm/types";
import { deleteLifecycle, listLifecycles, renameLifecycle } from "@/lib/crm/lifecycles";
import { revalidateRecordPages } from "@/lib/revalidate";
import { withActor } from "@/lib/crm/context";

export type CompanyActionState = {
  error?: string;
  field?: string;
  existingId?: string;
  company?: Company;
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

function tagsFromForm(formData: FormData) {
  if (!formData.has("tags")) return undefined;
  return formData.getAll("tags").filter((value): value is string => typeof value === "string");
}

function writeFromForm(formData: FormData): CompanyWrite {
  const lifecycle = text(formData, "lifecycle");
  const ownerId = text(formData, "ownerId");
  return {
    name: text(formData, "name"),
    domain: text(formData, "domain") || null,
    website: text(formData, "website") || null,
    industry: text(formData, "industry") || null,
    sizeCategory: text(formData, "sizeCategory") || null,
    description: text(formData, "description") || null,
    source: text(formData, "source") || null,
    lifecycle: lifecycle || "lead",
    ownerId: ownerId && ownerId !== "unassigned" ? ownerId : null,
    tags: tagsFromForm(formData),
  };
}

export async function createCompanyAction(
  _state: CompanyActionState,
  formData: FormData,
): Promise<CompanyActionState> {
  const user = await requireUser();
  try {
    const result = await createCompany(user, writeFromForm(formData), {
      provenance: { operation: "create_company", source: "web" },
    });
    revalidatePath("/");
    revalidateRecordPages();
    return { company: result.body.company };
  } catch (error) {
    return actionError(error);
  }
}

export async function updateCompanyAction(
  _state: CompanyActionState,
  formData: FormData,
): Promise<CompanyActionState> {
  const user = await requireUser();
  const id = text(formData, "id");
  try {
    const result = await updateCompany(user, id, writeFromForm(formData), {
      provenance: { operation: "update_company", source: "web" },
    });
    revalidatePath("/");
    revalidateRecordPages();
    return { company: result.body.company };
  } catch (error) {
    return actionError(error);
  }
}

export async function patchCompanyAction(id: string, patch: CompanyWrite): Promise<{ company?: Company; error?: string }> {
  const user = await requireUser();
  try {
    const result = await updateCompany(user, id, patch, { provenance: { operation: "update_company", source: "web" } });
    revalidatePath("/");
    revalidateRecordPages();
    return { company: result.body.company };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function setCompanyLifecycleAction(id: string, lifecycle: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await updateCompany(user, id, { lifecycle }, { provenance: { operation: "set_lifecycle", source: "web" } });
    revalidatePath("/");
    revalidateRecordPages();
    return {};
  } catch (error) {
    return actionError(error);
  }
}

export async function listLifecyclesAction(): Promise<LifecycleCount[]> {
  const user = await getUserActor();
  if (!user) return [];
  return listLifecycles(user);
}

export async function renameLifecycleAction(from: string, to: string): Promise<{ companies?: number; error?: string }> {
  const user = await requireUser();
  try {
    const result = await renameLifecycle(user, from, to);
    revalidatePath("/");
    revalidateRecordPages();
    return result;
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteLifecycleAction(name: string): Promise<{ companies?: number; error?: string }> {
  const user = await requireUser();
  try {
    const result = await deleteLifecycle(user, name);
    revalidatePath("/");
    revalidateRecordPages();
    return result;
  } catch (error) {
    return actionError(error);
  }
}

export async function setCompanyHealthAction(id: string, health: AccountHealth | null): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await updateCompany(user, id, { health, healthReason: null }, { provenance: { operation: "set_health", source: "web" } });
    revalidatePath("/");
    revalidateRecordPages();
    revalidatePath("/opportunities");
    revalidatePath("/boards", "layout");
    return {};
  } catch (error) {
    return actionError(error);
  }
}

export async function archiveCompanyAction(id: string): Promise<CompanyActionState> {
  const user = await requireUser();
  try {
    await archiveCompany(user, id, {
      provenance: { operation: "archive_company", source: "web" },
    });
    revalidatePath("/");
    revalidateRecordPages();
    return {};
  } catch (error) {
    return actionError(error);
  }
}

export async function mergeCompanyAction(mergeId: string, keepId: string): Promise<{ error?: string; keptId?: string }> {
  const user = await requireUser();
  try {
    const result = await mergeCompanies(user, keepId, mergeId, { operation: "merge_companies", source: "web" });
    revalidatePath("/");
    revalidateRecordPages();
    revalidatePath("/contacts");
    revalidatePath("/opportunities");
    revalidatePath("/boards", "layout");
    return { keptId: result.kept.id };
  } catch (error) {
    return { error: actionError(error).error };
  }
}

export async function searchCompaniesAction(query: string) {
  const user = await getUserActor();
  if (!user) return [];
  const result = await listCompanies(user, {
    query,
    limit: 20,
    sort: "name",
    order: "asc",
  });
  return result.data;
}

export async function exportCompaniesAction(filters: CompanyListQuery) {
  const user = await requireUser();
  const rows = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await listCompanies(user, { ...filters, limit: 100, offset });
    rows.push(...page.data);
    total = page.total;
    offset += page.data.length;
  } while (rows.length < total && offset < 5000);
  return companiesCsvRows(rows);
}

export async function updateNameAction(name: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return { error: "Enter your name." };
  if (clean.length > 120) return { error: "Keep your name under 120 characters." };
  await withActor(user, (db) => db.query("update crm.profiles set full_name = $2 where id = $1", [user.userId, clean]));
  revalidatePath("/", "layout");
  return {};
}

export async function changePasswordAction(password: string, confirm: string): Promise<{ error?: string }> {
  await requireUser();
  if (!supabaseConfigured()) return { error: "Passwords are managed outside Orbit on this server." };
  if (password.length < 8) return { error: "Use at least 8 characters." };
  if (password !== confirm) return { error: "The two passwords don't match." };
  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message.includes("different") ? "Choose a password you haven't used here before." : "Your password couldn't be changed. Sign in again and retry." };
  return {};
}

export async function signOutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  if (supabaseConfigured()) {
    const supabase = await createSupabaseServer();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
