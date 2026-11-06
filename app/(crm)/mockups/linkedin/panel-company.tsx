"use client";

import Button from "@/components/_ui/button";
import { lifecycleTagBase, RecordTag } from "@/components/beautifui/record-marks";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import NoteIcon from "@/public/assets/images/crm/activity/note.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import { KESTREL, NORTHLIGHT, type MockWorkspace } from "./mock-data";
import { Card, Facts, OpenInOrbit, OrbitPanel, QuickActions, RecordHead, Section, SelectField, Status, TextField, type QuickAction } from "./panel-ui";

const COMPANY_ACTIONS: QuickAction[] = [
  { key: "task", label: "Add task", icon: ClipboardIcon },
  { key: "note", label: "Add note", icon: NoteIcon },
  { key: "people", label: "People in Orbit", icon: UsersIcon },
  { key: "update", label: "Update from page", icon: RefreshIcon },
];

export function CompanyPanel({ workspace }: { workspace: MockWorkspace }) {
  return (
    <OrbitPanel workspace={workspace}>
      <div className="flex items-start justify-between gap-3">
        <Status tone="in" title="In Orbit" detail="Matched by domain" />
        <OpenInOrbit />
      </div>
      <Card>
        <RecordHead square initials={NORTHLIGHT.initials} name={NORTHLIGHT.name} lines={[NORTHLIGHT.website]} />
        <div className="border-border border-t pt-3">
          <Facts
            rows={[
              { label: "Lifecycle", value: <RecordTag label={NORTHLIGHT.lifecycle} base={lifecycleTagBase("prospect")} /> },
              {
                label: "Deal",
                value: (
                  <span className="flex flex-col">
                    <span>GEO pilot · £4,800</span>
                    <span className="caption-style text-subtle">Sales, Proposal sent</span>
                  </span>
                ),
              },
              { label: "People", value: NORTHLIGHT.people.map((person) => person.name).join(", ") },
              { label: "Open tasks", value: "2, next due today" },
              { label: "Owner", value: NORTHLIGHT.owner },
            ]}
          />
        </div>
      </Card>
      <div className="flex flex-col gap-2">
        <QuickActions actions={COMPANY_ACTIONS} />
        <p className="caption-style text-subtle leading-[1.4]">Its LinkedIn page isn&apos;t saved yet. Update from page adds it.</p>
      </div>
      <Section title="AI fields" action={<Button variant="ghost" size="sm">Check again</Button>}>
        <dl className="grid grid-cols-[6.5em_1fr] gap-x-3 gap-y-3 text-[13px] leading-5">
          {NORTHLIGHT.ai.map((field) => (
            <div key={field.label} className="contents">
              <dt className="caption-style text-subtle leading-5">{field.label}</dt>
              <dd className="flex min-w-0 flex-col gap-0.5">
                <span>
                  {field.value}
                  {field.detail && <span className="caption-style text-subtle"> {field.detail}</span>}
                </span>
                <span className="caption-style text-subtle">{field.meta}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </OrbitPanel>
  );
}

export function NewCompanyPanel({ workspace }: { workspace: MockWorkspace }) {
  return (
    <OrbitPanel
      workspace={workspace}
      footer={
        <>
          <Button variant="primary" size="md" className="h-9 w-full">
            Save company
          </Button>
          <p className="caption-style text-subtle text-center">Fit and AI fields are checked after it&apos;s saved.</p>
        </>
      }
    >
      <Status tone="new" title={`Not in ${workspace.name}`} detail="No company with this domain or LinkedIn page." />
      <Section title="From this page">
        <Card>
          <RecordHead square initials={KESTREL.initials} name={KESTREL.name} lines={[KESTREL.tagline]} />
          <div className="border-border border-t pt-3">
            <Facts
              rows={[
                { label: "Website", value: KESTREL.website },
                { label: "Industry", value: KESTREL.industry },
                { label: "Size", value: "11-50" },
                { label: "Location", value: KESTREL.location },
              ]}
            />
          </div>
        </Card>
      </Section>
      <Section title="Company">
        <TextField label="Name" value={KESTREL.name} />
        <TextField label="Domain" value={KESTREL.website} hint="Orbit fills in the logo, description and links from the domain." />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Lifecycle" options={["Lead", "Prospect", "Customer"]} />
          <SelectField label="Owner" options={["Mark Ridgeon", "Unassigned"]} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Board" options={["No board", "Sales", "Outreach"]} value="Outreach" />
          <SelectField label="Stage" options={["To contact", "Contacted", "Replied"]} />
        </div>
        <TextField label="Tags" value="agency" />
      </Section>
    </OrbitPanel>
  );
}
