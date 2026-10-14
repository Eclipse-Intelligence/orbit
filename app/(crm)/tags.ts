"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { BulkActionResult } from "@/app/(crm)/bulk";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import {
  addTags,
  deleteTag,
  editTags,
  removeTags,
  renameTag,
  type TagChangeCount,
} from "@/lib/crm/tags";
import { normalizeTags } from "@/lib/crm/normalize";
import type { Actor, TagKind } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export type RecordTagsResult = { tags: string[] } | { error: string };
export type TagChangeResult = TagChangeCount | { error: string };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

function refresh() {
  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
  revalidateRecordPages();
}

function message(error: unknown, fallback: string) {
  return error instanceof CrmError ? error.message : fallback;
}

function kindOf(kind: unknown): TagKind {
  if (kind === "contact" || kind === "company") return kind;
  throw new CrmError("invalid_input", "Choose contacts or companies.", 400);
}

async function editRecord(
  user: Actor,
  kind: unknown,
  id: string,
  tag: string,
  mode: "add" | "remove",
): Promise<RecordTagsResult> {
  try {
    const [wanted] = normalizeTags([tag]);
    if (!wanted) return { error: "Enter a tag." };
    const record = await editTags(
      user,
      kindOf(kind),
      id,
      (current) =>
        mode === "add" ? [...current, wanted] : current.filter((item) => item !== wanted),
      { operation: mode === "add" ? "add_tags" : "remove_tags", source: "web" },
    );
    refresh();
    return { tags: record.tags };
  } catch (error) {
    return { error: message(error, "Could not save the tag.") };
  }
}

export async function addRecordTagAction(kind: TagKind, id: string, tag: string) {
  return editRecord(await requireUser(), kind, id, tag, "add");
}

export async function removeRecordTagAction(kind: TagKind, id: string, tag: string) {
  return editRecord(await requireUser(), kind, id, tag, "remove");
}

async function bulkTag(
  kind: TagKind,
  ids: string[],
  tag: string,
  mode: "add" | "remove",
): Promise<BulkActionResult> {
  const user = await requireUser();
  try {
    const run = mode === "add" ? addTags : removeTags;
    const results = await run(user, kindOf(kind), ids, [tag]);
    refresh();
    return { results };
  } catch (error) {
    return { error: message(error, "Something went wrong.") };
  }
}

export async function bulkAddTagAction(kind: TagKind, ids: string[], tag: string) {
  return bulkTag(kind, ids, tag, "add");
}

export async function bulkRemoveTagAction(kind: TagKind, ids: string[], tag: string) {
  return bulkTag(kind, ids, tag, "remove");
}

export async function renameTagAction(from: string, to: string): Promise<TagChangeResult> {
  const user = await requireUser();
  try {
    const result = await renameTag(user, from, to);
    refresh();
    return result;
  } catch (error) {
    return { error: message(error, "Could not rename the tag.") };
  }
}

export async function deleteTagAction(name: string): Promise<TagChangeResult> {
  const user = await requireUser();
  try {
    const result = await deleteTag(user, name);
    refresh();
    return result;
  } catch (error) {
    return { error: message(error, "Could not delete the tag.") };
  }
}
