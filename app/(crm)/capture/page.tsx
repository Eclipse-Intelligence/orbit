import { redirect } from "next/navigation";
import { after } from "next/server";
import CaptureScreen from "@/components/capture/capture-screen";
import { getUserActor } from "@/lib/auth/user";
import { listWaitingOnOthers } from "@/lib/crm/action-needed";
import { getCalendarStatus } from "@/lib/crm/calendar";
import { getCallSync } from "@/lib/crm/calls";
import { captureContext, captureStatus, connectionAlert, listToFile, markCaptureSeen, waitingHere } from "@/lib/crm/capture";
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
  const context = await captureContext(user, openedAt.getTime());
  const [items, status, calls, granola, transcripts, calendar, followUps, unknown, others] = await Promise.all([
    listToFile(user, openedAt.getTime()),
    captureStatus(user, openedAt.getTime(), context),
    mailbox ? getCallSync(user) : Promise.resolve(null),
    getGranolaStatus(user),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
    live ? getCalendarStatus(user) : Promise.resolve(null),
    listFollowUps(user).catch(() => []),
    listUnknownMail(user, openedAt.getTime(), { actors: context.actors, emails: context.unknown }).catch((error) => {
      console.error("Reading email from new people failed", error instanceof Error ? error.message : error);
      return { emails: [], total: 0, workspaces: [{ id: user.workspaceId, name: user.workspaceName }] };
    }),
    listWaitingOnOthers(user, openedAt).catch(() => []),
  ]);
  after(async () => {
    try {
      await markCaptureSeen(user, openedAt);
    } catch (error) {
      console.error("Could not mark Capture as seen", error);
    }
  });
  const here = waitingHere(context, user.workspaceId);

  return (
    <CaptureScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      data={{
        approvals: here.approvals,
        others,
        nudges: here.nudges,
        calls: followUps,
        replies: here.replies,
        tasks: here.tasks,
        emails: unknown.emails,
        unfiled: items.unfiled,
        people: items.people,
      }}
      toFileTotal={status.sections.toFile}
      workspaces={unknown.workspaces}
      workspaceId={user.workspaceId}
      now={openedAt.getTime()}
      newestAt={status.newestAt}
      alert={connectionAlert({ mailbox, calendar, calls, granola, transcripts })}
    />
  );
}
