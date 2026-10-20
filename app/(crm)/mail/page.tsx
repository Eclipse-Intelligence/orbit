import { redirect } from "next/navigation";
import MailScreen from "@/components/mail/mail-screen";
import { getUserActor } from "@/lib/auth/user";
import { composeAccounts } from "@/lib/mail/compose";
import { getThread, listThreads, mailNav } from "@/lib/mail/threads";
import { readMailView, mailViewParam } from "@/lib/mail/view";

export const dynamic = "force-dynamic";

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
  const view = readMailView(text(resolved.view));
  const query = text(resolved.q).trim().slice(0, 300);
  const nav = await mailNav(user);
  const account = nav.accounts.some((item) => item.id === text(resolved.account)) ? text(resolved.account) : null;
  const threadKey = text(resolved.thread);
  const [page, thread, accounts] = await Promise.all([
    listThreads(user, { view, sourceId: account, query }),
    threadKey ? getThread(user, threadKey).catch(() => null) : Promise.resolve(null),
    composeAccounts(user).catch(() => []),
  ]);

  return (
    <MailScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      initialNav={nav}
      initialQuery={{ view: mailViewParam(view), account, query }}
      initialPage={page}
      initialThread={thread}
      initialNow={requestTime()}
      accounts={accounts}
    />
  );
}
