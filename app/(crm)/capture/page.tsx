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
import type { CaptureSection } from "@/lib/crm/capture-format";
import { classifyCapture, listSenderRules, listUnknownMail } from "@/lib/mail/capture-filter";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

function requestTime() {
  return new Date();
}

function logged<T>(label: string, fallback: T) {
  return (error: unknown) => {
    console.error(label, error instanceof Error ? error.message : error);
    return fallback;
  };
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
  const context = await captureContext(user, openedAt.getTime(), { inline: true });
  const failed = new Set<CaptureSection>(context.failed);
  const [items, status, calls, granola, transcripts, calendar, followUps, unknown, others] = await Promise.all([
    listToFile(user, openedAt.getTime()).catch((error) => {
      failed.add("toFile");
      return logged("Reading what's waiting to file failed", { unfiled: [], people: [] })(error);
    }),
    captureStatus(user, openedAt.getTime(), context).catch(logged("Counting Capture failed", null)),
    mailbox ? getCallSync(user) : Promise.resolve(null),
    getGranolaStatus(user),
    live ? getTeamsTranscriptStatus(user) : Promise.resolve(null),
    live ? getCalendarStatus(user) : Promise.resolve(null),
    listFollowUps(user).catch((error) => {
      failed.add("followUps");
      return logged("Reading call follow-ups failed", [])(error);
    }),
    listUnknownMail(user, openedAt.getTime(), { actors: context.actors, emails: context.unknown, skipped: context.skipped, pending: context.held }).catch((error) => {
      failed.add("toFile");
      return logged("Reading email from new people failed", {
        emails: [],
        total: 0,
        notShown: [],
        notShownTotal: 0,
        sorting: 0,
        workspaces: [{ id: user.workspaceId, name: user.workspaceName }],
      })(error);
    }),
    listWaitingOnOthers(user, openedAt).catch(logged("Reading approvals waiting on others failed", [])),
  ]);
  const rules = await listSenderRules(user).catch(logged("Reading Capture rules failed", []));
  after(async () => {
    try {
      await markCaptureSeen(user, openedAt);
    } catch (error) {
      console.error("Could not mark Capture as seen", error);
    }
  });
  if (context.held.length > 0) {
    after(async () => {
      try {
        await classifyCapture(user, { budgetMs: 25_000 });
      } catch (error) {
        console.error("Sorting Capture email failed", error instanceof Error ? error.message : error);
      }
    });
  }
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
        reminders: here.reminders,
        calls: followUps,
        replies: here.replies,
        tasks: here.tasks,
        emails: unknown.emails,
        notShown: unknown.notShown,
        unfiled: items.unfiled,
        people: items.people,
      }}
      toFileTotal={status?.sections.toFile ?? 0}
      notShownTotal={unknown.notShownTotal}
      sorting={unknown.sorting}
      rules={rules}
      failed={[...failed]}
      workspaces={unknown.workspaces}
      workspaceId={user.workspaceId}
      now={openedAt.getTime()}
      newestAt={status?.newestAt ?? null}
      alert={connectionAlert({ mailbox, calendar, calls, granola, transcripts })}
    />
  );
}
