"use server";

import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { addMailAttachmentToKnowledge } from "@/lib/knowledge/attachments";
import { resumeStale, scheduleIndexing } from "@/lib/knowledge/background";
import { mapSite, type SiteMap } from "@/lib/knowledge/site";
import {
  addKnowledgeLink,
  addKnowledgePages,
  archiveKnowledge,
  getKnowledgeItem,
  listKnowledge,
  mapItem,
  PAGES_ADD_MAX,
  prepareKnowledgeUpload,
  renameKnowledge,
  targetFrom,
  type KnowledgeItem,
} from "@/lib/knowledge/store";

type Target = { companyId?: string; eclipse?: boolean };

function failure(error: unknown, fallback: string) {
  if (!(error instanceof CrmError)) console.error(fallback, error);
  return { error: error instanceof CrmError ? error.message : fallback };
}

export async function listKnowledgeAction(target: Target): Promise<{ items?: KnowledgeItem[]; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to see Knowledge." };
  try {
    const items = await listKnowledge(user, targetFrom(target));
    resumeStale(user, items);
    return { items };
  } catch (error) {
    return failure(error, "Couldn't load Knowledge.");
  }
}

export async function prepareKnowledgeUploadAction(
  target: Target,
  file: { name: string; size: number; contentType: string },
): Promise<{ item?: KnowledgeItem; uploadUrl?: string; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to upload." };
  try {
    return await prepareKnowledgeUpload(user, targetFrom(target), file);
  } catch (error) {
    return failure(error, "Couldn't start the upload.");
  }
}

export async function finishKnowledgeUploadAction(id: string): Promise<{ item?: KnowledgeItem; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to upload." };
  try {
    const row = await getKnowledgeItem(user, id);
    scheduleIndexing(user, [row.id]);
    return { item: mapItem(row) };
  } catch (error) {
    return failure(error, "Couldn't finish the upload.");
  }
}

export async function addKnowledgeLinkAction(target: Target, url: string): Promise<{ item?: KnowledgeItem; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to add links." };
  try {
    const item = await addKnowledgeLink(user, targetFrom(target), { url });
    scheduleIndexing(user, [item.id]);
    return { item };
  } catch (error) {
    return failure(error, "Couldn't add the link.");
  }
}

export async function retryKnowledgeAction(id: string): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to retry." };
  try {
    const row = await getKnowledgeItem(user, id);
    scheduleIndexing(user, [row.id], { force: row.status === "ready" });
    return {};
  } catch (error) {
    return failure(error, "Couldn't retry it.");
  }
}

export async function renameKnowledgeAction(id: string, title: string): Promise<{ item?: KnowledgeItem; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to rename." };
  try {
    return { item: await renameKnowledge(user, id, title) };
  } catch (error) {
    return failure(error, "Couldn't rename it.");
  }
}

export async function removeKnowledgeAction(id: string): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to remove." };
  try {
    await archiveKnowledge(user, id);
    return {};
  } catch (error) {
    return failure(error, "Couldn't remove it.");
  }
}

export async function addAttachmentToKnowledgeAction(messageId: string, attachmentId: string, target: Target): Promise<{ added?: boolean; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to add to Knowledge." };
  try {
    const { item, created } = await addMailAttachmentToKnowledge(user, messageId, attachmentId, targetFrom(target));
    if (created) scheduleIndexing(user, [item.id]);
    return { added: created };
  } catch (error) {
    return failure(error, "Couldn't add it to Knowledge.");
  }
}

export async function mapSiteAction(url: string): Promise<{ map?: SiteMap; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to map a site." };
  try {
    return { map: await mapSite(url, { deadline: Date.now() + 90_000 }) };
  } catch (error) {
    return failure(error, "Couldn't map that site.");
  }
}

export async function addKnowledgePagesAction(target: Target, urls: string[]): Promise<{ items?: KnowledgeItem[]; added?: number; skipped?: number; error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to add pages." };
  try {
    const parsed = targetFrom(target);
    const { ids, skipped } = await addKnowledgePages(user, parsed, urls);
    scheduleIndexing(user, ids);
    return { items: await listKnowledge(user, parsed), added: ids.length, skipped };
  } catch (error) {
    return failure(error, "Couldn't add those pages.");
  }
}

export async function retryKnowledgeItemsAction(ids: string[]): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to retry." };
  scheduleIndexing(user, ids.slice(0, PAGES_ADD_MAX));
  return {};
}

export async function removeKnowledgeItemsAction(ids: string[]): Promise<{ error?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to remove." };
  try {
    for (const id of ids.slice(0, PAGES_ADD_MAX)) await archiveKnowledge(user, id);
    return {};
  } catch (error) {
    return failure(error, "Couldn't remove them.");
  }
}
