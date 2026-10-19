import { headers } from "next/headers";
import { redirect } from "next/navigation";
import InboxScreen from "@/components/crm/inbox-screen";
import { getUserActor } from "@/lib/auth/user";
import { getCalendarStatus, listPeopleMet } from "@/lib/crm/calendar";
import { getCallSync } from "@/lib/crm/calls";
import { listUnfiledImports } from "@/lib/crm/conversations";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox, listInbox, shouldSyncMailbox, syncMailbox } from "@/lib/crm/inbox";
import { getTeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import { mailSyncStatus } from "@/lib/mail/store";
import { microsoftConfigured, microsoftRedirectUri } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const notice = typeof resolved.error === "string" ? resolved.error : null;
  const info = typeof resolved.info === "string" ? resolved.info : null;
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
  const live = mailbox?.status === "connected";
  const [messages, calls, unfiled, granola, transcripts, calendar, people, mirror] = await Promise.all([
    mailbox ? listInbox(user) : Promise.resolve([]),
    mailbox ? getCallSync(user) : Promise.resolve(null),
    listUnfiledImports(user),
    getGranolaStatus(user),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
    live ? getCalendarStatus(user) : Promise.resolve(null),
    mailbox ? listPeopleMet(user) : Promise.resolve([]),
    mailSyncStatus(user),
  ]);
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
      calls={calls}
      unfiled={unfiled}
      granola={granola}
      transcripts={transcripts}
      calendar={calendar}
      people={people}
      mirror={mirror}
      notice={notice}
      info={info}
      connected={connected}
    />
  );
}
