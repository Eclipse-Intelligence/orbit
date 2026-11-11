"use server";

import { getUserActor } from "@/lib/auth/user";
import { getClickUpPicker, type ClickUpPicker } from "@/lib/crm/clickup";
import { listMembers } from "@/lib/crm/companies";
import { getContact } from "@/lib/crm/contacts";
import { listPipeline } from "@/lib/crm/opportunities";
import { contactRecipient, type Recipient } from "@/lib/crm/personalise";
import { listTags } from "@/lib/crm/tags";
import type { Member, PipelineStage, TagCount } from "@/lib/crm/types";

export type QuickAddSetup = {
  stages: PipelineStage[];
  clickup: ClickUpPicker | null;
  tags: TagCount[];
  members: Member[];
};

export async function emailRecipientAction(contactId: string): Promise<Recipient | null> {
  const user = await getUserActor();
  if (!user) return null;
  try {
    return contactRecipient(await getContact(user, contactId));
  } catch {
    return null;
  }
}

export async function quickAddSetupAction(): Promise<QuickAddSetup> {
  const user = await getUserActor();
  if (!user) return { stages: [], clickup: null, tags: [], members: [] };
  const [pipeline, clickup, tags, members] = await Promise.all([
    listPipeline(user),
    getClickUpPicker(user).catch(() => null),
    listTags(user),
    listMembers(user).catch(() => []),
  ]);
  return { stages: pipeline.stages, clickup, tags, members };
}
