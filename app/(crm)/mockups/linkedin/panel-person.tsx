"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { Radio } from "@/components/_ui/radio";
import { lifecycleTagBase, RecordTag } from "@/components/beautifui/record-marks";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import NoteIcon from "@/public/assets/images/crm/activity/note.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import { ECLIPSE, HANNAH, PRIYA, PRIYA_RECORD, RIDGEON, TOM, type MockWorkspace } from "./mock-data";
import {
  AreaField,
  Card,
  Facts,
  OpenInOrbit,
  OrbitPanel,
  QuickActions,
  RecordHead,
  Section,
  SelectField,
  Status,
  TextField,
  type QuickAction,
} from "./panel-ui";

export const PERSON_ACTIONS: QuickAction[] = [
  { key: "task", label: "Add task", icon: ClipboardIcon },
  { key: "note", label: "Add note", icon: NoteIcon },
  { key: "message", label: "Log message", icon: MailIcon },
  { key: "update", label: "Update from page", icon: RefreshIcon },
];

function SaveOptions({ board }: { board: string }) {
  return (
    <Section title="Options">
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Owner" options={["Mark Ridgeon", "Unassigned"]} />
        <TextField label="Tags" value="agency" />
        <SelectField label="Board" options={["No board", "Sales", "Outreach"]} value={board} />
        <SelectField label="Stage" options={["To contact", "Contacted", "Replied", "Call booked"]} />
      </div>
    </Section>
  );
}

export function NewPersonPanel({ workspace, menu }: { workspace: MockWorkspace; menu?: boolean }) {
  const domainId = useId();
  return (
    <OrbitPanel
      workspace={workspace}
      menu={menu}
      presence={{ [ECLIPSE.id]: "Not in Orbit", [RIDGEON.id]: "In Orbit, saved 2 Oct" }}
      footer={
        <>
          <Button variant="primary" size="md" className="h-9 w-full">
            Save to Orbit
          </Button>
          <p className="caption-style text-subtle text-center">Adds {HANNAH.name} and {HANNAH.company} to {workspace.name}.</p>
        </>
      }
    >
      <Status
        tone="new"
        title={`Not in ${workspace.name}`}
        detail={menu ? `In ${RIDGEON.name}. Switch to see the record there.` : "No one with this profile, or this name at this company."}
      />
      <Section title="From this page">
        <Card>
          <RecordHead
            initials={HANNAH.initials}
            name={HANNAH.name}
            lines={[HANNAH.headline]}
            action={
              <Button variant="ghost" size="sm">
                Edit
              </Button>
            }
          />
          <div className="border-border border-t pt-3">
            <Facts
              rows={[
                { label: "Job title", value: HANNAH.role },
                {
                  label: "Company",
                  value: (
                    <span className="flex flex-col">
                      <span>{HANNAH.company}</span>
                      <span className="caption-style text-subtle">New company</span>
                    </span>
                  ),
                },
                { label: "Location", value: "Bristol, England" },
                { label: "LinkedIn", value: <span className="text-soft">linkedin.com/in/{HANNAH.slug}</span> },
              ]}
            />
          </div>
        </Card>
        <p className="caption-style text-subtle leading-[1.4]">Read from the page you&apos;re on. Nothing is saved until you press Save.</p>
      </Section>
      <div className="flex flex-col gap-2">
        <label htmlFor={domainId} className="caption-style text-soft">
          Company domain
        </label>
        <Input id={domainId} placeholder="fernhill.digital" aria-describedby={`${domainId}-hint`} />
        <span id={`${domainId}-hint`} className="caption-style text-subtle leading-[1.4]">
          Optional. Matches an existing company and fills in its details.
        </span>
      </div>
      <SaveOptions board="Outreach" />
    </OrbitPanel>
  );
}

function TaskForm() {
  return (
    <Section title="New task">
      <TextField label="Title" value="Send pricing for both clients" />
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <TextField label="Due" value="Sat 7 Nov" />
        <SelectField label="Remind" options={["At due time", "1 hour before", "1 day before", "No reminder"]} />
      </div>
      <div className="flex flex-wrap gap-1">
        {["Today", "Tomorrow", "Next week"].map((label) => (
          <Button key={label} variant={label === "Tomorrow" ? "muted" : "ghost"} size="sm">
            {label}
          </Button>
        ))}
      </div>
      <p className="caption-style text-subtle leading-[1.4]">On Priya Shah and Northlight SEO. Yours.</p>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button variant="primary" size="sm">
          Add task
        </Button>
      </div>
    </Section>
  );
}

function NoteForm() {
  return (
    <Section title="New note">
      <AreaField label="Note" rows={5} value="Met at the Manchester SEO meetup. Wants one price for two clients, decides by the end of the month." />
      <p className="caption-style text-subtle leading-[1.4]">Saved as a note on Priya Shah and Northlight SEO.</p>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button variant="primary" size="sm">
          Add note
        </Button>
      </div>
    </Section>
  );
}

function MessageForm() {
  const sentId = useId();
  const receivedId = useId();
  const whenId = useId();
  return (
    <Section title="Log LinkedIn message">
      <fieldset className="flex flex-col gap-2">
        <legend className="caption-style text-soft mb-2">Direction</legend>
        <span className="flex gap-4">
          <label htmlFor={receivedId} className="ui-style flex items-center gap-2">
            <Radio id={receivedId} name="direction" defaultChecked />
            From Priya
          </label>
          <label htmlFor={sentId} className="ui-style flex items-center gap-2">
            <Radio id={sentId} name="direction" />
            From you
          </label>
        </span>
      </fieldset>
      <div className="flex flex-col gap-2">
        <label htmlFor={whenId} className="caption-style text-soft">
          When
        </label>
        <Input id={whenId} defaultValue="Today, 08:02" />
      </div>
      <AreaField label="Message" rows={4} placeholder="Paste or type the message" value="Great. Also, could you join our team call on the 14th?" />
      <p className="caption-style text-subtle leading-[1.4]">Saved as a LinkedIn activity on Priya Shah. In a message thread, Log this conversation does this for you.</p>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button variant="primary" size="sm">
          Log message
        </Button>
      </div>
    </Section>
  );
}

function ChangeRow({ label, before, after, changed }: { label: string; before: string; after: string; changed: boolean }) {
  const id = useId();
  return (
    <li className="border-border flex items-start gap-3 border-t py-2.5 first:border-t-0 first:pt-0">
      <Checkbox id={id} defaultChecked={changed} disabled={!changed} className="mt-0.5" aria-label={`Update ${label}`} />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="caption-style text-subtle">{label}</span>
        {changed ? (
          <span className="text-[13px] leading-5">
            <span className="text-subtle line-through decoration-white/30">{before || "Empty"}</span>
            <span className="text-subtle"> to </span>
            <span>{after}</span>
          </span>
        ) : (
          <span className="text-soft text-[13px] leading-5">{after} <span className="text-subtle">· same</span></span>
        )}
      </label>
    </li>
  );
}

function UpdateForm() {
  return (
    <Section title="Update from page">
      <ul className="flex flex-col">
        <ChangeRow label="Job title" before="Founder" after="Founder and CEO" changed />
        <ChangeRow label="Location" before="" after="Manchester, England" changed />
        <ChangeRow label="Company" before="Northlight SEO" after="Northlight SEO" changed={false} />
        <ChangeRow label="Name" before="Priya Shah" after="Priya Shah" changed={false} />
      </ul>
      <p className="caption-style text-subtle leading-[1.4]">Only ticked changes are saved. A new company would move Priya and keep her history.</p>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button variant="primary" size="sm">
          Update 2 fields
        </Button>
      </div>
    </Section>
  );
}

export function KnownSummary({ compact }: { compact?: boolean }) {
  if (compact)
    return (
      <Card>
        <RecordHead initials={PRIYA.initials} name={PRIYA.name} lines={[`${PRIYA_RECORD.jobTitle} · ${PRIYA_RECORD.company}`, `${PRIYA_RECORD.deal.name}, ${PRIYA_RECORD.deal.stage} · 2 open tasks`]} />
      </Card>
    );
  return (
    <Card>
      <RecordHead
        initials={PRIYA.initials}
        name={PRIYA.name}
        lines={[`${PRIYA_RECORD.jobTitle} · ${PRIYA_RECORD.company}`, PRIYA_RECORD.email]}
      />
      <span className="flex flex-wrap gap-1">
        {PRIYA_RECORD.tags.map((tag) => (
          <RecordTag key={tag} label={tag} />
        ))}
      </span>
      <div className="border-border border-t pt-3">
        <Facts
          rows={[
            {
              label: "Company",
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  {PRIYA_RECORD.company}
                  <RecordTag label={PRIYA_RECORD.lifecycle} base={lifecycleTagBase("prospect")} />
                </span>
              ),
            },
            {
              label: "Deal",
              value: (
                <span className="flex flex-col">
                  <span>
                    {PRIYA_RECORD.deal.name} · {PRIYA_RECORD.deal.value}
                  </span>
                  <span className="caption-style text-subtle">
                    {PRIYA_RECORD.deal.board}, {PRIYA_RECORD.deal.stage}
                  </span>
                </span>
              ),
            },
            {
              label: "Last contact",
              value: (
                <span className="flex flex-col">
                  <span className="truncate">{PRIYA_RECORD.lastInteraction.title}</span>
                  <span className="caption-style text-subtle">
                    {PRIYA_RECORD.lastInteraction.kind}, {PRIYA_RECORD.lastInteraction.when}
                  </span>
                </span>
              ),
            },
            {
              label: "Open tasks",
              value: (
                <ul className="flex flex-col gap-1">
                  {PRIYA_RECORD.tasks.map((task) => (
                    <li key={task.title} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{task.title}</span>
                      <span className={task.due === "Today" ? "caption-style text-warning shrink-0" : "caption-style text-subtle shrink-0"}>{task.due}</span>
                    </li>
                  ))}
                </ul>
              ),
            },
            { label: "Owner", value: PRIYA_RECORD.owner },
          ]}
        />
      </div>
    </Card>
  );
}

export function InOrbitPanel({ workspace, active }: { workspace: MockWorkspace; active?: "task" | "note" | "message" | "update" }) {
  return (
    <OrbitPanel workspace={workspace}>
      <div className="flex items-start justify-between gap-3">
        <Status tone="in" title="In Orbit" detail="Matched by LinkedIn profile" />
        <OpenInOrbit />
      </div>
      <KnownSummary compact={Boolean(active)} />
      <QuickActions actions={PERSON_ACTIONS} active={active} />
      {active === "task" && <TaskForm />}
      {active === "note" && <NoteForm />}
      {active === "message" && <MessageForm />}
      {active === "update" && <UpdateForm />}
    </OrbitPanel>
  );
}

export function SalesNavPanel({ workspace }: { workspace: MockWorkspace }) {
  return (
    <OrbitPanel
      workspace={workspace}
      footer={<p className="caption-style text-subtle text-center">Doesn&apos;t change your lead lists or Sales Navigator notes.</p>}
    >
      <Status tone="maybe" title="Possible match" detail="Lead pages have no public profile link, so this is matched by name and company." />
      <Card>
        <RecordHead initials={TOM.initials} name={TOM.name} lines={["Director · Brightline PR", "No LinkedIn saved · added 12 Sep from email"]} />
        <div className="flex gap-1.5">
          <Button variant="primary" size="sm">
            Same person
          </Button>
          <Button variant="secondary" size="sm">
            Not them
          </Button>
          <span className="ml-auto">
            <OpenInOrbit label="Open" />
          </span>
        </div>
        <p className="caption-style text-subtle leading-[1.4]">Same person saves this lead page on Tom&apos;s record, so it matches straight away next time.</p>
      </Card>
      <Section title="From this page">
        <Facts
          rows={[
            { label: "Name", value: TOM.name },
            { label: "Job title", value: TOM.role },
            { label: "Company", value: TOM.company },
            { label: "Location", value: "Leeds, England" },
          ]}
        />
      </Section>
      <Section title="Quick actions">
        <div className="pointer-events-none opacity-50">
          <QuickActions actions={PERSON_ACTIONS} />
        </div>
        <p className="caption-style text-subtle leading-[1.4]">Confirm the match first, or press Not them to save Tom as a new person.</p>
      </Section>
    </OrbitPanel>
  );
}
