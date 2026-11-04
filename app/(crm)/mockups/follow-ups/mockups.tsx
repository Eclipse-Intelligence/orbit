"use client";

import type { Viewer } from "@/components/crm/viewer";
import CaptureMock from "./capture-mock";
import { ComposerCard, ToolbarComparison } from "./composer-mock";
import MailFrame, { ROWS } from "./mail-frame";
import TasksMock from "./tasks-mock";
import ThreadMock from "./thread-mock";

export type MockState =
  | "A"
  | "A-reminder"
  | "B-empty"
  | "B-written"
  | "C"
  | "C-unwritten"
  | "C-done"
  | "D-capture"
  | "D-notification"
  | "E-thread"
  | "E-task";

const SCHEDULED_ROWS = ROWS.map((row) => (row.key === "jane" ? { ...row, count: undefined, people: "Me", followUpOn: "Mon 9 Nov" } : row));
const REPLIED_ROWS = ROWS.map((row) => (row.key === "jane" ? { ...row, people: "Jane Doe", count: 3, when: "14:20", unread: true, snippet: "Thanks, this looks good. I'll share it with Tom" } : row));
const NOT_NOW_ROWS = ROWS.map((row) =>
  row.key === "jane" ? { ...row, people: "Jane Doe", count: 3, when: "14:20", unread: true, snippet: "Can we pick this up in January?" } : row,
);

export default function FollowUpMockups({ state, viewer }: { state: MockState; viewer: Viewer }) {
  if (state === "A" || state === "B-empty" || state === "B-written") {
    return (
      <>
        <MailFrame viewer={viewer} />
        <ComposerCard mode={state === "A" ? "menu" : state === "B-empty" ? "empty" : "written"} />
      </>
    );
  }
  if (state === "A-reminder") {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <ToolbarComparison />
      </section>
    );
  }
  if (state === "C" || state === "C-unwritten") {
    return (
      <MailFrame viewer={viewer} rows={SCHEDULED_ROWS} active="jane">
        <ThreadMock mode={state === "C" ? "scheduled" : "unwritten"} />
      </MailFrame>
    );
  }
  if (state === "C-done") {
    return (
      <MailFrame viewer={viewer} rows={REPLIED_ROWS} active="jane">
        <ThreadMock mode="done" />
      </MailFrame>
    );
  }
  if (state === "E-thread") {
    return (
      <MailFrame viewer={viewer} rows={NOT_NOW_ROWS} active="jane">
        <ThreadMock mode="not-now" />
      </MailFrame>
    );
  }
  if (state === "E-task") return <TasksMock viewer={viewer} />;
  return <CaptureMock viewer={viewer} notifications={state === "D-notification"} />;
}
