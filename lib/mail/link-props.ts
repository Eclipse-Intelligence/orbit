import { mailViewParam, readMailView } from "@/lib/mail/view";
import { SHARED_VIEW } from "@/lib/mail/share-view";

export type LinkedList = { view: string; account: string | null; query: string };

export function listFromUrl(params: URLSearchParams): LinkedList {
  const raw = params.get("view") || "inbox";
  const query = (params.get("q") ?? "").trim().slice(0, 300);
  const view = raw === "scheduled" && !query ? "scheduled" : raw === SHARED_VIEW && !query ? SHARED_VIEW : mailViewParam(readMailView(raw));
  return { view, account: params.get("account") || null, query };
}

export function linkMatchesUrl(params: URLSearchParams, link: { thread: string | null; query: LinkedList }) {
  const live = listFromUrl(params);
  const thread = params.get("thread");
  return (
    (thread ?? null) === link.thread &&
    live.query === link.query.query &&
    (live.account ?? null) === (link.query.account ?? null) &&
    (live.query !== "" || live.view === link.query.view)
  );
}
