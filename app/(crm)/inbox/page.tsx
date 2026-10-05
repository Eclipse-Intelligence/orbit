import { headers } from "next/headers";
import { redirect } from "next/navigation";
import InboxScreen from "@/components/crm/inbox-screen";
import { getUserActor } from "@/lib/auth/user";
import { getMailbox, listInbox, shouldSyncMailbox, syncMailbox } from "@/lib/crm/inbox";
import { microsoftConfigured, microsoftRedirectUri } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const notice = typeof resolved.error === "string" ? resolved.error : null;
  const connected = resolved.connected === "1";

  let mailbox = await getMailbox(user);
  if (
    microsoftConfigured() &&
    mailbox?.status === "connected" &&
    shouldSyncMailbox(mailbox.lastAttemptAt) &&
    !notice
  ) {
    await syncMailbox(user);
    mailbox = await getMailbox(user);
  }
  const messages = mailbox ? await listInbox(user) : [];
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  return (
    <InboxScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      configured={microsoftConfigured()}
      redirectUri={microsoftRedirectUri(`${proto}://${host}`)}
      mailbox={mailbox}
      messages={messages}
      notice={notice}
      connected={connected}
    />
  );
}
