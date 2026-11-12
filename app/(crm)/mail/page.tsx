import { redirect } from "next/navigation";
import MailScreen from "@/components/mail/mail-screen";
import { getUserActor } from "@/lib/auth/user";
import { composeAccounts } from "@/lib/mail/compose";
import { getThread, listThreads, mailNav } from "@/lib/mail/threads";
import { readMailView, mailViewParam, type MailNav } from "@/lib/mail/view";
import { isUuid } from "@/lib/crm/mutate";
import { ownSharedThreadKey } from "@/lib/mail/shares";
import { SHARE_NOTES_PARAM, SHARED_PARAM } from "@/lib/mail/share-types";
import { readShareParam, SHARED_VIEW } from "@/lib/mail/share-view";

export const dynamic = "force-dynamic";

const PARTIAL_NAV: MailNav = { accounts: [], folders: [], unread: 0, snoozed: 0, scheduled: 0, splits: [], partial: true };

function requestTime() {
  return Date.now();
}

function text(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const view = readMailView(text(resolved.view) || "inbox");
  const query = text(resolved.q).trim().slice(0, 300);
  const account = isUuid(text(resolved.account)) ? text(resolved.account) : null;
  const shared = readShareParam(text(resolved[SHARED_PARAM]));
  const notes = text(resolved[SHARE_NOTES_PARAM]) === "1" && Boolean(shared);
  const compose = text(resolved.compose);
  const scheduledView = text(resolved.view) === "scheduled" && !query;
  const askedShared = text(resolved.view) === SHARED_VIEW && !query;
  const navPromise = mailNav(user).catch((error) => {
    console.error("Mail nav failed", error);
    return null;
  });
  const empty = { threads: [], next: null };
  const ownerKeyPromise = shared ? ownSharedThreadKey(user, shared).catch(() => null) : Promise.resolve(null);
  const list = () => listThreads(user, { view, sourceId: account, query });
  const [page, thread, accounts, ownerKey] = await Promise.all([
    scheduledView || askedShared ? Promise.resolve(empty) : shared && !query ? ownerKeyPromise.then((key) => (key ? list() : empty)) : list(),
    ownerKeyPromise.then((key) => {
      const wanted = key ?? (shared ? "" : text(resolved.thread));
      return wanted ? getThread(user, wanted, { reader: true }).catch(() => null) : null;
    }),
    composeAccounts(user).catch((error) => {
      console.error("Mail accounts failed", error);
      return null;
    }),
    ownerKeyPromise,
  ]);
  const sharedOpen = shared && !ownerKey ? shared : null;
  const noMailbox = accounts !== null && accounts.length === 0;
  const sharedView = !query && !ownerKey && !thread && (Boolean(sharedOpen) || askedShared || noMailbox);

  return (
    <MailScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      initialNav={PARTIAL_NAV}
      navPromise={navPromise}
      initialQuery={{ view: sharedView ? SHARED_VIEW : scheduledView ? "scheduled" : mailViewParam(view), account, query }}
      initialPage={sharedView ? empty : page}
      initialThread={thread}
      initialCompose={thread && (compose === "reply" || compose === "prepared") ? compose : null}
      initialShared={sharedView ? sharedOpen : null}
      linkedShare={shared}
      noMailbox={noMailbox}
      initialNotes={notes}
      initialNow={requestTime()}
      accounts={accounts ?? []}
    />
  );
}
