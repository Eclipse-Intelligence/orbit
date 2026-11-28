import type { DocComment } from "@/lib/docs/comments";

export type Thread = { root: DocComment; replies: DocComment[] };

export function threadsOf(comments: DocComment[]): Thread[] {
  return comments.filter((comment) => comment.parentId === null).map((root) => ({ root, replies: comments.filter((comment) => comment.parentId === root.id) }));
}

export function threadHolding(threads: Thread[], commentId: string) {
  return threads.find((thread) => thread.root.id === commentId || thread.replies.some((reply) => reply.id === commentId)) ?? null;
}
