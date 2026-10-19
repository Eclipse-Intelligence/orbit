"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { sendOwnMail } from "@/lib/crm/inbox";
import { createInvite, inviteEmail, removeMember, revokeInvite, setMemberRole } from "@/lib/crm/team";
import { siteOrigin } from "@/lib/site-url";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

async function origin() {
  const configured = siteOrigin();
  if (configured) return configured;
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:3000";
  const protocol = headerStore.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

function message(error: unknown, fallback: string) {
  return error instanceof CrmError ? error.message : fallback;
}

export async function inviteAction(input: {
  email: string;
  role: string;
  send: boolean;
}): Promise<{ link?: string; email?: string; sent?: boolean; sendError?: string; error?: string }> {
  const user = await requireUser();
  let invite: Awaited<ReturnType<typeof createInvite>>;
  try {
    invite = await createInvite(user, { email: input.email, role: input.role });
  } catch (error) {
    return { error: message(error, "Couldn't create the invite.") };
  }
  const link = `${await origin()}/join/${invite.token}`;
  revalidatePath(SETTINGS_PATHS.team);
  if (!input.send) return { link, email: invite.email, sent: false };
  try {
    const mail = inviteEmail({ workspaceName: user.workspaceName, inviterName: user.fullName || user.email, link });
    await sendOwnMail(user, { to: invite.email, ...mail });
    return { link, email: invite.email, sent: true };
  } catch (error) {
    return { link, email: invite.email, sent: false, sendError: message(error, "Couldn't send the email.") };
  }
}

export async function revokeInviteAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await revokeInvite(user, id);
    revalidatePath(SETTINGS_PATHS.team);
    return {};
  } catch (error) {
    return { error: message(error, "Couldn't cancel the invite.") };
  }
}

export async function setRoleAction(userId: string, role: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await setMemberRole(user, userId, role);
    revalidatePath(SETTINGS_PATHS.team);
    return {};
  } catch (error) {
    return { error: message(error, "Couldn't change their role.") };
  }
}

export async function removeMemberAction(userId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await removeMember(user, userId);
    revalidatePath("/", "layout");
    return {};
  } catch (error) {
    return { error: message(error, "Couldn't remove them.") };
  }
}
