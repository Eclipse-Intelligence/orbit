"use server";

import { getUserActor } from "@/lib/auth/user";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { getTeam } from "@/lib/crm/team";
import { listArchivedDocs, listFormerOwners, takeOverFormerMemberDocs } from "@/lib/docs/admin";
import { archiveFolder, folderSharing, listFolders, restoreFolder } from "@/lib/docs/folders";
import { docsAction } from "@/lib/docs/http";

const PROVENANCE: Provenance = { operation: "docs.app" };

export type ArchivedNote = { id: string; title: string; kind: "note" | "daily"; dailyDate: string | null; archivedAt: string };
export type ArchivedFolder = { id: string; name: string; archivedAt: string };
export type FormerMember = { id: string; name: string; examples: string[] };
export type ArchivedDocs = { notes: ArchivedNote[]; folders: ArchivedFolder[]; formerMembers: FormerMember[] | null };

function canAdminister(actor: UserActor) {
  return actor.role === "owner" || actor.role === "admin";
}

async function formerMembers(actor: UserActor): Promise<FormerMember[]> {
  const [team, folders] = await Promise.all([getTeam(actor), listFolders(actor)]);
  const members = new Set(team.members.map((member) => member.id));
  const found = new Map<string, FormerMember>();
  for (const owner of await listFormerOwners(actor, [...members])) found.set(owner.id, owner);
  for (const folder of folders) {
    if (!folder.owner || members.has(folder.owner.id)) continue;
    const member = found.get(folder.owner.id) ?? { id: folder.owner.id, name: folder.owner.name, examples: [] };
    if (member.examples.length < 3) member.examples.push(folder.name);
    found.set(folder.owner.id, member);
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function archivedDocsAction() {
  return docsAction(await getUserActor(), async (actor): Promise<ArchivedDocs> => {
    const [folders, docs] = await Promise.all([listFolders(actor, { archived: true }), listArchivedDocs(actor)]);
    const archivedIds = new Set(folders.map((folder) => folder.id));
    return {
      folders: folders
        .filter((folder) => !folder.parentId || !archivedIds.has(folder.parentId))
        .map((folder) => ({ id: folder.id, name: folder.name, archivedAt: folder.archivedAt ?? folder.updatedAt })),
      notes: docs
        .filter((doc) => !doc.folderId || !archivedIds.has(doc.folderId))
        .map((doc) => ({ id: doc.id, title: doc.title, kind: doc.kind, dailyDate: doc.dailyDate, archivedAt: doc.archivedAt ?? doc.updatedAt })),
      formerMembers: canAdminister(actor) ? await formerMembers(actor) : null,
    };
  });
}

export async function archiveFolderAction(id: string) {
  return docsAction(await getUserActor(), async (actor) => {
    await archiveFolder(actor, id, PROVENANCE);
    return { archived: true };
  });
}

export async function restoreFolderAction(id: string) {
  return docsAction(await getUserActor(), async (actor) => {
    await restoreFolder(actor, id, PROVENANCE);
    return { restored: true };
  });
}

export async function folderSharingAction(id: string) {
  return docsAction(await getUserActor(), async (actor) => {
    const sharing = await folderSharing(actor, id);
    return { sharedOnTheirOwn: sharing.sharedOnTheirOwn, ownedByOthers: sharing.ownedByOthers };
  });
}

export async function takeOverDocsAction(formerUserId: string) {
  return docsAction(await getUserActor(), (actor) => takeOverFormerMemberDocs(actor, formerUserId));
}
