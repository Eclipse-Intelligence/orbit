"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { archiveProof, createProof, updateProof, type ProofEntry, type ProofWrite } from "@/lib/crm/proof";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export type ProofResult = { entry: ProofEntry; error?: undefined } | { error: string; field?: string };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function failure(error: unknown, fallback: string) {
  if (error instanceof CrmError) {
    const field = typeof error.details?.field === "string" ? error.details.field : undefined;
    return { error: error.message, ...(field ? { field } : {}) };
  }
  return { error: fallback };
}

export async function saveProofAction(id: string | null, input: ProofWrite): Promise<ProofResult> {
  const user = await requireUser();
  try {
    const entry = id
      ? await updateProof(user, id, input, { operation: "update_proof_entry", source: "web" })
      : await createProof(user, input, { operation: "create_proof_entry", source: "web" });
    revalidatePath(SETTINGS_PATHS.knowledge);
    return { entry };
  } catch (error) {
    return failure(error, "That proof didn't save. Try again.");
  }
}

export async function archiveProofAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await archiveProof(user, id, { operation: "archive_proof_entry", source: "web" });
    revalidatePath(SETTINGS_PATHS.knowledge);
    return {};
  } catch (error) {
    return failure(error, "That proof wasn't removed. Try again.");
  }
}
