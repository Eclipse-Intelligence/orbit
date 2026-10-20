"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createJoinAccount, signInJoined } from "@/lib/auth/accounts";
import { CrmError } from "@/lib/crm/errors";
import { acceptInvite, previewInvite } from "@/lib/crm/team";
import { siteOrigin } from "@/lib/site-url";

export type JoinState = { error?: string; name?: string; confirmEmail?: string };

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function origin() {
  const configured = siteOrigin();
  if (configured) return configured;
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:3000";
  const protocol = headerStore.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

export async function joinAction(_state: JoinState, formData: FormData): Promise<JoinState> {
  const token = text(formData, "token");
  const name = text(formData, "name");
  const password = typeof formData.get("password") === "string" ? String(formData.get("password")) : "";
  const kept = { name };
  if (!name) return { ...kept, error: "Enter your name." };
  const invite = await previewInvite(token);
  if (!invite || invite.status !== "pending") return { ...kept, error: "This invite is no longer valid. Ask for a new one." };
  let workspaceId: string;
  let needsConfirmation = false;
  try {
    const account = await createJoinAccount({ email: invite.email, password, fullName: name.slice(0, 120) }, await origin());
    workspaceId = await acceptInvite(token, account.userId);
    needsConfirmation = account.needsConfirmation;
    await signInJoined(account, invite.email, password, workspaceId);
  } catch (error) {
    return { ...kept, error: error instanceof CrmError ? error.message : "Couldn't set up your login. Try again." };
  }
  if (needsConfirmation) return { ...kept, confirmEmail: invite.email };
  redirect("/mail");
}
