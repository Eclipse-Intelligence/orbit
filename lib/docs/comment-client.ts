import type { CommentAnchor } from "@/lib/docs/comment-anchor";
import type { PublicComment } from "@/lib/docs/public-comments";

export type { PublicComment };

export type CommentThread = { root: PublicComment; replies: PublicComment[] };

const STORAGE_KEY = "orbit.public-doc-comments";

export type Visitor = { name: string; key: string };

export function newVisitorKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function loadVisitor(): Visitor {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Visitor>) : null;
    if (parsed && typeof parsed.key === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(parsed.key)) {
      return { key: parsed.key, name: typeof parsed.name === "string" ? parsed.name.slice(0, 60) : "" };
    }
  } catch {}
  const visitor = { key: newVisitorKey(), name: "" };
  saveVisitor(visitor);
  return visitor;
}

export function saveVisitor(visitor: Visitor) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visitor));
  } catch {}
}

export function threadsOf(comments: PublicComment[]): CommentThread[] {
  const roots = comments.filter((comment) => comment.parentId === null);
  return roots.map((root) => ({ root, replies: comments.filter((comment) => comment.parentId === root.id) }));
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string; gone: boolean };

async function send<T>(token: string, key: string, path: string, init: RequestInit, fallback: string, pick: (json: Record<string, unknown>) => T): Promise<Result<T>> {
  try {
    const response = await fetch(`/api/d/${encodeURIComponent(token)}/comments${path}`, {
      ...init,
      cache: "no-store",
      headers: { "content-type": "application/json", "x-visitor-key": key },
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: typeof json.error === "string" ? json.error : fallback, gone: response.status === 404 };
    return { ok: true, value: pick(json) };
  } catch {
    return { ok: false, error: fallback, gone: false };
  }
}

export function fetchComments(token: string, key: string) {
  return send(token, key, "", { method: "GET" }, "Couldn't load comments. Try again.", (json) => (Array.isArray(json.comments) ? (json.comments as PublicComment[]) : []));
}

export function postComment(token: string, key: string, input: { name: string; body: string; parentId?: string; anchor?: CommentAnchor }) {
  return send(token, key, "", { method: "POST", body: JSON.stringify(input) }, "Couldn't comment. Try again.", (json) => json.comment as PublicComment);
}

export function patchComment(token: string, key: string, id: string, body: string) {
  return send(token, key, `/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }, "Couldn't save the comment. Try again.", (json) => json.comment as PublicComment);
}

export function removeComment(token: string, key: string, id: string) {
  return send(token, key, `/${id}`, { method: "DELETE" }, "Couldn't delete the comment. Try again.", () => true);
}
