import Button from "@/components/_ui/button";
import CaptureSeen from "@/components/crm/capture-seen";
import FollowUpCalls from "@/components/crm/follow-up-calls";
import PeopleMet from "@/components/crm/people-met";
import SectionHeader from "@/components/crm/section-header";
import UnfiledConversations from "@/components/crm/unfiled-conversations";
import UnknownMail from "@/components/crm/unknown-mail";
import type { Viewer } from "@/components/crm/viewer";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import type { MetPerson } from "@/lib/crm/calendar";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import type { UnknownEmail } from "@/lib/mail/filing";
import type { WorkspaceChoiceRef } from "@/lib/mail/view";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export default function CaptureScreen({
  viewer,
  followUps,
  unfiled,
  people,
  emails,
  workspaces,
  workspaceId,
  now,
  total,
  newestAt,
  alert,
}: {
  viewer: Viewer;
  followUps: FollowUpSuggestion[];
  unfiled: UnfiledImport[];
  people: MetPerson[];
  emails: UnknownEmail[];
  workspaces: WorkspaceChoiceRef[];
  workspaceId: string;
  now: number;
  total: number;
  newestAt: string | null;
  alert: string | null;
}) {
  const shown = unfiled.length + people.length + emails.length;
  const toFile = Math.max(total, shown);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CaptureSeen newestAt={newestAt} />
      <SectionHeader title="Capture" viewer={viewer} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
          {alert && (
            <p role="alert" className="caption-style text-warning flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]">
              <span>{alert}</span>
              <Button variant="link" size="none" href={`${SETTINGS_PATHS.integrations}#microsoft`} className="caption-style">
                Open Integrations
              </Button>
            </p>
          )}

          <FollowUpCalls suggestions={followUps} />

          <section aria-labelledby="to-file-heading" className="flex flex-col gap-3">
            <h2 id="to-file-heading" className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
              To file
              {toFile > 0 && <span className="text-soft tracking-normal tabular-nums">{toFile}</span>}
            </h2>
            {toFile > shown && (
              <p className="caption-style text-subtle leading-[1.4]">
                Showing the latest {shown} of {toFile}.
              </p>
            )}
            {shown === 0 ? (
              <p className="caption-style text-subtle leading-[1.4]">Nothing to file.</p>
            ) : (
              <KeyboardList className="flex flex-col gap-6">
                <UnknownMail emails={emails} workspaces={workspaces} currentId={workspaceId} now={now} />
                <UnfiledConversations conversations={unfiled} />
                <PeopleMet people={people} />
              </KeyboardList>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
