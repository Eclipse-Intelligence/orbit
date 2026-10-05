"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { disconnectMailbox, syncMailbox } from "@/lib/crm/inbox";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

export async function syncInboxAction() {
  const user = await requireUser();
  const result = await syncMailbox(user);
  revalidatePath("/inbox");
  revalidatePath("/");
  if (result.error) redirect(`/inbox?error=${encodeURIComponent(result.error)}`);
  redirect("/inbox");
}

export async function disconnectInboxAction() {
  const user = await requireUser();
  await disconnectMailbox(user);
  revalidatePath("/inbox");
  redirect("/inbox");
}
