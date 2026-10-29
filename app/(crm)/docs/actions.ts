"use server";

import { getUserActor } from "@/lib/auth/user";
import type { CreateInput, ShareTarget, Visibility } from "@/lib/docs/client-types";
import { docsAction, docsChanges } from "@/lib/docs/http";

export async function createDocAction(input: CreateInput) {
  return docsAction(await getUserActor(), (actor) => docsChanges.create(actor, input));
}

export async function renameDocAction(id: string, title: string) {
  return docsAction(await getUserActor(), (actor) => docsChanges.rename(actor, id, title));
}

export async function moveDocAction(id: string, folderId: string | null, allowVisibilityChange = false) {
  return docsAction(await getUserActor(), (actor) => docsChanges.move(actor, id, folderId, allowVisibilityChange));
}

export async function archiveDocAction(id: string) {
  return docsAction(await getUserActor(), (actor) => docsChanges.archive(actor, id));
}

export async function restoreDocAction(id: string) {
  return docsAction(await getUserActor(), (actor) => docsChanges.restore(actor, id));
}

export async function setAssistantCanEditAction(id: string, value: boolean) {
  return docsAction(await getUserActor(), (actor) => docsChanges.assistantCanEdit(actor, id, value));
}

export async function createFolderAction(name: string, parentId: string | null) {
  return docsAction(await getUserActor(), (actor) => docsChanges.createFolder(actor, name, parentId));
}

export async function renameFolderAction(id: string, name: string) {
  return docsAction(await getUserActor(), (actor) => docsChanges.renameFolder(actor, id, name));
}

export async function moveFolderAction(id: string, parentId: string | null, position: number, allowVisibilityChange = false) {
  return docsAction(await getUserActor(), (actor) => docsChanges.moveFolder(actor, id, parentId, position, allowVisibilityChange));
}

export async function shareDocsAction(target: ShareTarget, visibility: Visibility) {
  return docsAction(await getUserActor(), (actor) => docsChanges.share(actor, target, visibility));
}

export async function restoreVersionAction(pageId: string, versionId: string) {
  return docsAction(await getUserActor(), (actor) => docsChanges.restoreVersion(actor, pageId, versionId));
}
