"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { cn } from "@/lib/utils";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import { PRIYA, THREAD, type MockWorkspace, type ThreadMessage } from "./mock-data";
import { Card, Facts, OpenInOrbit, OrbitPanel, RecordHead, Section, Status, TextField } from "./panel-ui";

const LOGGED = new Set(["m1", "m2"]);
const UNTICKED = new Set(["m5"]);

export function ConversationPanel({ workspace }: { workspace: MockWorkspace }) {
  return (
    <OrbitPanel workspace={workspace}>
      <div className="flex items-start justify-between gap-3">
        <Status tone="in" title="In Orbit" detail="Matched by the profile link in this thread" />
        <OpenInOrbit />
      </div>
      <Card>
        <RecordHead initials={PRIYA.initials} name={PRIYA.name} lines={["Founder · Northlight SEO", "Last logged here 3 Nov, 2 messages"]} />
      </Card>
      <Section title="This conversation">
        <Button variant="primary" size="md" className="h-10 w-full">
          <MailIcon aria-hidden className="size-3.5" />
          Log this conversation
        </Button>
        <ul className="caption-style text-subtle flex flex-col gap-1.5 leading-[1.4]">
          <li>Logs only the messages on screen when you press it.</li>
          <li>Orbit never reads your messages on its own. Scroll up first to include older ones.</li>
          <li>Messages you&apos;ve logged before are skipped.</li>
        </ul>
      </Section>
    </OrbitPanel>
  );
}

function MessageRow({ message }: { message: ThreadMessage }) {
  const id = useId();
  const logged = LOGGED.has(message.id);
  return (
    <li className={cn("border-border flex items-start gap-3 border-t py-3 first:border-t-0 first:pt-0", logged && "opacity-55")}>
      <Checkbox id={id} defaultChecked={!logged && !UNTICKED.has(message.id)} disabled={logged} className="mt-0.5" aria-label={`Log message from ${message.from}, ${message.when}`} />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="caption-style flex items-baseline justify-between gap-2">
          <span className="text-soft truncate">{message.mine ? "You" : message.from}</span>
          <span className="text-subtle shrink-0">{logged ? "Logged 3 Nov" : message.when}</span>
        </span>
        <span className="text-[13px] leading-[1.45]">{message.text}</span>
      </label>
    </li>
  );
}

export function ConversationPickPanel({ workspace }: { workspace: MockWorkspace }) {
  const chosen = THREAD.filter((message) => !LOGGED.has(message.id) && !UNTICKED.has(message.id)).length;
  return (
    <OrbitPanel
      workspace={workspace}
      footer={
        <>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="md" className="h-9">
              Cancel
            </Button>
            <Button variant="primary" size="md" className="h-9 flex-1">
              Log {chosen} messages
            </Button>
          </div>
          <p className="caption-style text-subtle text-center">Saved as one LinkedIn activity. Nothing else from the thread is kept.</p>
        </>
      }
    >
      <Status tone="wait" title={`${THREAD.length} messages on screen`} detail="Read when you pressed Log this conversation at 08:14. Untick any you don't want." />
      <Section title="Messages">
        <ul className="flex flex-col">
          {THREAD.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </ul>
      </Section>
      <Section title="Log to">
        <Facts
          rows={[
            { label: "Person", value: "Priya Shah" },
            { label: "Company", value: "Northlight SEO" },
            { label: "Type", value: "LinkedIn" },
          ]}
        />
        <TextField label="Title" value="LinkedIn messages with Priya Shah" />
      </Section>
    </OrbitPanel>
  );
}
