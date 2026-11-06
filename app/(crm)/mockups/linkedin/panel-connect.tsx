"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import Logo from "@/public/assets/images/_common/logo.svg";
import { ECLIPSE, WORKSPACES } from "./mock-data";
import { Card, OrbitPanel, Section, Status } from "./panel-ui";

const CODE = "KQ7M-4TXP";

function ReadsList() {
  return (
    <Section title="What it reads">
      <ul className="flex flex-col gap-2.5 text-[13px] leading-[1.45]">
        <li className="flex flex-col gap-0.5">
          <span>The page address</span>
          <span className="caption-style text-subtle">To check if a person or company is in Orbit.</span>
        </li>
        <li className="flex flex-col gap-0.5">
          <span>Name, headline, company and location</span>
          <span className="caption-style text-subtle">Only while this panel is open, from the page you&apos;re on.</span>
        </li>
        <li className="flex flex-col gap-0.5">
          <span>Messages</span>
          <span className="caption-style text-subtle">Only when you press Log this conversation.</span>
        </li>
      </ul>
      <p className="caption-style text-subtle leading-[1.4]">Works on LinkedIn and Sales Navigator only. It never opens pages or clicks for you.</p>
    </Section>
  );
}

export function ConnectPanel() {
  return (
    <OrbitPanel workspace={ECLIPSE} connected={false}>
      <div className="flex flex-col gap-3 pt-2">
        <Logo aria-hidden className="-ml-1 size-10 overflow-visible" />
        <h2 className="leading-6">Connect to Orbit</h2>
        <p className="text-subtle text-[13px] leading-[1.45]">Approve this browser in Orbit and choose its workspaces.</p>
        <Button variant="primary" size="md" className="h-9 w-full">
          Connect
        </Button>
      </div>
      <ReadsList />
    </OrbitPanel>
  );
}

export function WaitingPanel() {
  return (
    <OrbitPanel workspace={ECLIPSE} connected={false}>
      <div className="flex flex-col gap-4 pt-2">
        <Status tone="wait" title="Approve in Orbit" detail="Orbit opened in a new tab. Check it shows this code." />
        <Card className="items-center py-5">
          <span className="font-mono text-[22px] leading-none tracking-[0.12em]">{CODE}</span>
        </Card>
        <div className="flex gap-1.5">
          <Button variant="secondary" size="sm">
            Open the tab again
          </Button>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </div>
        <p className="caption-style text-subtle leading-[1.4]">The code works for 10 minutes.</p>
      </div>
    </OrbitPanel>
  );
}

export function TokenPanel() {
  const id = useId();
  return (
    <OrbitPanel workspace={ECLIPSE} connected={false}>
      <div className="flex flex-col gap-3 pt-2">
        <Logo aria-hidden className="-ml-1 size-10 overflow-visible" />
        <h2 className="leading-6">Connect to Orbit</h2>
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="caption-style text-soft">
            Personal token
          </label>
          <Input id={id} type="password" defaultValue="orbit_3fa9c21e_Qm8x" aria-describedby={`${id}-hint`} />
          <span id={`${id}-hint`} className="caption-style text-subtle leading-[1.4]">
            Create one in Orbit, Settings › API and webhooks.
          </span>
        </div>
        <Button variant="primary" size="md" className="h-9 w-full">
          Connect
        </Button>
        <p role="alert" className="caption-style text-warning leading-[1.4]">
          A personal token also opens your mail to anything that holds it, and works in one workspace only.
        </p>
      </div>
      <ReadsList />
    </OrbitPanel>
  );
}

function WorkspaceChoice({ id, name, checked }: { id: string; name: string; checked: boolean }) {
  const fieldId = useId();
  return (
    <label htmlFor={fieldId} className="border-border flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <Checkbox id={fieldId} defaultChecked={checked} />
      <WorkspaceTile id={id} name={name} />
      <span className="text-[14px] leading-5">{name}</span>
    </label>
  );
}

export function ApprovePage() {
  const nameId = useId();
  return (
    <div className="bg-background text-foreground absolute inset-0 flex items-start justify-center overflow-auto pt-[9vh]">
      <div className="flex w-full max-w-[26em] flex-col gap-6 px-6">
        <div className="flex flex-col items-start gap-4">
          <Logo aria-hidden className="size-10 overflow-visible" />
          <h1 className="leading-6">Connect Chrome extension</h1>
          <p className="text-subtle text-[14px] leading-5">The Orbit extension wants to use Orbit as Mark Ridgeon.</p>
        </div>
        <div className="border-sidebar-border bg-sidebar-accent flex flex-col gap-5 rounded-xl border p-5">
          <div className="flex flex-col gap-2">
            <span className="caption-style text-soft">Code shown in the extension</span>
            <span className="font-mono text-[20px] leading-none tracking-[0.12em]">{CODE}</span>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={nameId} className="caption-style text-soft">
              Name
            </label>
            <Input id={nameId} defaultValue="Chrome on MacBook Pro" />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="caption-style text-soft mb-2">Workspaces</legend>
            {WORKSPACES.map((workspace) => (
              <WorkspaceChoice key={workspace.id} id={workspace.id} name={workspace.name} checked />
            ))}
          </fieldset>
          <div className="caption-style text-subtle flex flex-col gap-1.5 leading-[1.4]">
            <span>It can look up and save people and companies, and add tasks, notes and LinkedIn activity.</span>
            <span>It can&apos;t read your mail, calendars, docs or assistant chats.</span>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="md">
              Cancel
            </Button>
            <Button variant="primary" size="md">
              Approve
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
