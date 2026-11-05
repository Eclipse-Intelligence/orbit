import { redirect } from "next/navigation";
import { after } from "next/server";
import CaptureScreen from "@/components/crm/inbox-screen";
import { getUserActor } from "@/lib/auth/user";
import { getCalendarStatus } from "@/lib/crm/calendar";
import { getCallSync } from "@/lib/crm/calls";
import { captureStatus, connectionAlert, listToFile, markCaptureSeen, newestArrival, unknownMailFor } from "@/lib/crm/capture";
import { listFollowUps } from "@/lib/crm/follow-ups";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox, shouldSyncMailbox, syncMailbox } from "@/lib/crm/inbox";
import { getTeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import { listUnknownMail } from "@/lib/mail/filing";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

function requestTime() {
  return new Date();
}

function later(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

export default async function CapturePage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const openedAt = requestTime();

  let mailbox = await getMailbox(user);
  if (microsoftConfigured() && mailbox?.status === "connected" && shouldSyncMailbox(mailbox.lastAttemptAt)) {
    await syncMailbox(user);
    mailbox = await getMailbox(user);
  }
  const live = mailbox?.status === "connected";
  const known = await unknownMailFor(user, openedAt.getTime());
  const [items, status, calls, granola, transcripts, calendar, followUps, unknown] = await Promise.all([
    listToFile(user, openedAt.getTime()),
    captureStatus(user, openedAt.getTime(), known.emails),
    mailbox ? getCallSync(user) : Promise.resolve(null),
    getGranolaStatus(user),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
    live ? getCalendarStatus(user) : Promise.resolve(null),
    listFollowUps(user).catch(() => []),
    listUnknownMail(user, openedAt.getTime(), known).catch((error) => {
      console.error("Reading email from new people failed", error instanceof Error ? error.message : error);
      return { emails: [], total: 0, workspaces: [{ id: user.workspaceId, name: user.workspaceName }] };
    }),
  ]);
  after(async () => {
    try {
      await markCaptureSeen(user, openedAt);
    } catch (error) {
      console.error("Could not mark Capture as seen", error);
    }
  });

  return (
    <CaptureScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      followUps={followUps}
      unfiled={items.unfiled}
      people={items.people}
      emails={unknown.emails}
      workspaces={unknown.workspaces}
      workspaceId={user.workspaceId}
      now={openedAt.getTime()}
      total={status.waiting - status.followUps}
      newestAt={later(later(newestArrival(items, openedAt.getTime()), status.newestAt), unknown.emails[0]?.at ?? null)}
      alert={connectionAlert({ mailbox, calendar, calls, granola, transcripts })}
    />
  );
}
