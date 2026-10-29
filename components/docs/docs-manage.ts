import { archiveFolderAction, restoreFolderAction } from "@/app/(crm)/docs/manage-actions";
import type { Folder } from "@/lib/docs/client-types";
import { useDocsStore } from "@/stores/docs-store";

export const ARCHIVED_HREF = "/docs?archived=1";

type Placeable = { ownerId: string; ownShared: boolean; viewerId: string | undefined; exclude?: Set<string> };

export function placeableFolders(folders: Folder[], { ownerId, ownShared, viewerId, exclude }: Placeable) {
  return folders.filter((folder) => !exclude?.has(folder.id) && (folder.shared || folder.owner.id === ownerId) && (ownShared || folder.shared || ownerId === viewerId));
}

export function canPlaceAtTop({ ownerId, ownShared, viewerId }: Placeable) {
  return ownShared || ownerId === viewerId;
}

export function descendantsOf(folders: Folder[], id: string) {
  const found = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && found.has(folder.parentId) && !found.has(folder.id)) {
        found.add(folder.id);
        grew = true;
      }
    }
  }
  return found;
}

export async function refreshDocsAfterRestore() {
  useDocsStore.setState({ lists: {} });
  const store = useDocsStore.getState();
  await store.refreshNav();
  void store.refreshTitles();
}

export async function restoreFolder(id: string, name: string) {
  const result = await restoreFolderAction(id);
  if (result.error !== undefined) return result.error;
  await refreshDocsAfterRestore();
  useDocsStore.getState().notify(`Restored ${name}.`);
  return null;
}

export async function archiveFolder(folder: Folder) {
  const result = await archiveFolderAction(folder.id);
  const store = useDocsStore.getState();
  if (result.error !== undefined) {
    store.notify(result.error, { tone: "alert" });
    return false;
  }
  await refreshDocsAfterRestore();
  store.notify(`Archived ${folder.name}.`, {
    undo: () => {
      void restoreFolder(folder.id, folder.name).then((problem) => {
        if (problem) useDocsStore.getState().notify(problem, { tone: "alert" });
      });
    },
  });
  return true;
}
