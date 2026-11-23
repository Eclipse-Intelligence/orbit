import { redirect } from "next/navigation";
import { takeMailRefusals } from "@/lib/mail/refusals";
import { after } from "next/server";
import CaptureScreen from "@/components/capture/capture-screen";
import { getUserActor } from "@/lib/auth/user";
import { getCalendarStatus } from "@/lib/crm/calendar";
import { getCallSync } from "@/lib/crm/calls";
import { captureContext, captureStatus, connectionAlert, listToFile, markCaptureSeen, waitingHere } from "@/lib/crm/capture";
import { listDismissedImports } from "@/lib/crm/conversations";
import { listFollowUps } from "@/lib/crm/follow-ups";
import { getGranolaStatus } from "@/lib/crm/granola";
import { getMailbox } from "@/lib/crm/inbox";
import { getTeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import type { CaptureSection } from "@/lib/crm/capture-format";
import { classifyCapture, listSenderRules, listUnknownMail } from "@/lib/mail/capture-filter";

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

  const failed = new Set<CaptureSection>();
  const mailboxLoad = getMailbox(user);
  const contextLoad = captureContext(user, openedAt.getTime(), { inline: true });
  const [mailbox, context, items, calls, granola, transcripts, calendar, followUps, status, unknown, dismissed, refusals, rules] = await Promise.all([
    mailboxLoad,
    contextLoad,
    listToFile(user, openedAt.getTime()).catch((error) => {
      failed.add("toFile");
      return logged("Reading what's waiting to file failed", { unfiled: [], people: [] })(error);
    }),
    mailboxLoad.then((mailbox) => (mailbox ? getCallSync(user) : null)),
    getGranolaStatus(user),
    mailboxLoad.then((mailbox) => (mailbox?.status === "connected" ? getTeamsTranscriptStatus(user) : null)),
    mailboxLoad.then((mailbox) => (mailbox?.status === "connected" ? getCalendarStatus(user) : null)),
    listFollowUps(user).catch((error) => {
      failed.add("followUps");
      return logged("Reading call follow-ups failed", [])(error);
    }),
    contextLoad.then((context) => captureStatus(user, openedAt.getTime(), context).catch(logged("Counting Capture failed", null))),
    contextLoad.then((context) =>
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
    ),
    listDismissedImports(user).catch(logged("Reading dismissed calls failed", { items: [], total: 0 })),
    takeMailRefusals(user).catch(() => []),
    listSenderRules(user).catch(logged("Reading Capture rules failed", [])),
  ]);
  for (const section of context.failed) failed.add(section);
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
        nudges: here.nudges,
        reminders: here.reminders,
        calls: followUps,
        replies: here.replies,
        emails: unknown.emails,
        notShown: unknown.notShown,
        unfiled: items.unfiled,
        people: items.people,
        dismissed: dismissed.items,
      }}
      toFileTotal={status?.sections.toFile ?? 0}
      notShownTotal={unknown.notShownTotal}
      dismissedTotal={dismissed.total}
      sorting={unknown.sorting}
      rules={rules}
      refusals={refusals}
      failed={[...failed]}
      workspaces={unknown.workspaces}
      workspaceId={user.workspaceId}
      now={openedAt.getTime()}
      newestAt={status?.newestAt ?? null}
      alert={connectionAlert({ mailbox, calendar, calls, granola, transcripts })}
    />
  );
}
