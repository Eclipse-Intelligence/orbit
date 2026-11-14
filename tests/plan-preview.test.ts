import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanProposal } from "@/lib/crm/plan-tasks";
import type { Task } from "@/lib/crm/types";
import {
  applyPayload,
  carryOver,
  chooseMiss,
  dragEntry,
  handPlaced,
  leaveOverdue,
  moveAllOverdue,
  moveOverdue,
  previewBlocks,
  previewRuns,
  previewSummary,
  removeEntry,
  runHeading,
  runLabel,
  startPreview,
  undoMiss,
  undoOverdue,
} from "@/lib/plan-preview";

const LONDON = "Europe/London";
const ids = { a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b", c: "00000000-0000-4000-8000-00000000000c", o: "00000000-0000-4000-8000-00000000000d", m: "00000000-0000-4000-8000-00000000000e" };

function proposal(): PlanProposal {
  const entry = (taskId: string, title: string, at: string, group: "call" | "email" | "other" = "call") => ({
    taskId,
    workspaceId: "ws",
    title,
    group,
    at,
    durationMinutes: 15,
    suggested: false,
    moveDay: null,
  });
  return {
    from: "2026-11-12",
    to: "2026-11-26",
    placed: [entry(ids.a, "Call Ann", "2026-11-16T10:30:00.000Z"), entry(ids.b, "Call Ben", "2026-11-16T10:45:00.000Z"), entry(ids.c, "Draft terms", "2026-11-16T14:00:00.000Z", "other")],
    overdue: [
      { taskId: ids.o, workspaceId: "ws", title: "Ring Ashby", group: "call", dueAt: "2026-11-10T14:00:00.000Z", dueHasTime: true, at: "2026-11-12T15:20:00.000Z", durationMinutes: 15, suggested: false },
    ],
    unplaced: [
      {
        taskId: ids.m,
        workspaceId: "ws",
        title: "Draft the rollout plan",
        group: "other",
        durationMinutes: 120,
        suggested: false,
        day: "2026-11-16",
        reason: "No 2 hour gap on Mon 16 Nov",
        nextFree: "2026-11-17T09:00:00.000Z",
        outside: "2026-11-16T17:30:00.000Z",
      },
    ],
    reason: null,
    ordering: [],
    replan: false,
  };
}

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: "ws",
    title,
    description: null,
    dueAt: "2026-11-16T00:00:00.000Z",
    dueDate: "2026-11-16",
    dueHasTime: false,
    durationMinutes: 15,
    scheduledBy: null,
    remindMinutes: null,
    completedAt: null,
    priority: "normal",
    ownerId: "me",
    ownerName: null,
    companyId: null,
    companyName: null,
    companyPhone: null,
    contactId: null,
    contactCompanyId: null,
    contactName: null,
    contactFirstName: null,
    contactLastName: null,
    contactJobTitle: null,
    contactPhone: null,
    contactEmail: null,
    opportunityId: null,
    opportunityName: null,
    createdByUserId: null,
    createdByAgentId: null,
    archivedAt: null,
    clickupTaskId: null,
    clickupListId: null,
    clickupUrl: null,
    clickupError: null,
    inOutlook: false,
    mailThreadKey: null,
    mailThread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Plan preview", () => {
  it("starts from the proposal and outlines back-to-back calls as a run", () => {
    const preview = startPreview(proposal());
    assert.equal(previewSummary(preview), "3 blocks · 45m");
    const runs = previewRuns(preview.entries, LONDON);
    assert.equal(runs.length, 1);
    assert.equal(runLabel(runs[0]), "2 calls · 30m");
    assert.equal(runHeading(runs[0]), "2 calls in a row");
    assert.equal(runHeading({ group: "call", count: 6, minutes: 90 }), "6 calls in a row, then a break");
  });

  it("moves an overdue task on Move, keeps a dragged one on Move all, and undoes Leave", () => {
    let preview = moveOverdue(startPreview(proposal()), ids.o, LONDON);
    const moved = preview.entries.find((entry) => entry.taskId === ids.o)!;
    assert.equal(moved.moveDay, "2026-11-12");
    preview = dragEntry(preview, { id: ids.o, dueAt: "2026-11-10T14:00:00.000Z", dueHasTime: true }, "2026-11-13T09:00:00.000Z", 30, LONDON);
    preview = moveAllOverdue(preview, LONDON);
    const dragged = preview.entries.find((entry) => entry.taskId === ids.o)!;
    assert.equal(dragged.at, "2026-11-13T09:00:00.000Z", "Move all keeps the drag");
    assert.equal(dragged.byHand, true);
    assert.equal(dragged.moveDay, "2026-11-13");
    preview = undoOverdue(preview, ids.o);
    preview = leaveOverdue(preview, ids.o);
    assert.equal(preview.overdue[ids.o], "leave");
    assert.ok(!preview.entries.some((entry) => entry.taskId === ids.o));
    preview = undoOverdue(preview, ids.o);
    assert.equal(preview.overdue[ids.o], undefined);
  });

  it("puts a Couldn't fit task on its next free day or outside hours only when chosen", () => {
    let preview = chooseMiss(startPreview(proposal()), ids.m, "next", LONDON);
    assert.deepEqual(
      preview.entries.filter((entry) => entry.taskId === ids.m).map((entry) => [entry.at, entry.moveDay]),
      [["2026-11-17T09:00:00.000Z", "2026-11-17"]],
    );
    preview = undoMiss(preview, ids.m);
    preview = chooseMiss(preview, ids.m, "outside", LONDON);
    assert.equal(preview.entries.find((entry) => entry.taskId === ids.m)?.moveDay, null, "outside hours keeps its day");
    preview = chooseMiss(preview, ids.m, "leave", LONDON);
    assert.ok(!preview.entries.some((entry) => entry.taskId === ids.m));
  });

  it("marks a dragged proposal as placed by hand and sends it so", () => {
    let preview = dragEntry(startPreview(proposal()), { id: ids.a, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-17T11:00:00.000Z", 30, LONDON);
    preview = removeEntry(preview, ids.c);
    assert.deepEqual(applyPayload(preview), [
      { taskId: ids.b, at: "2026-11-16T10:45:00.000Z", durationMinutes: 15 },
      { taskId: ids.a, at: "2026-11-17T11:00:00.000Z", durationMinutes: 30, moveDay: "2026-11-17", byHand: true },
    ]);
  });

  it("keeps edits when the plan is made again, as with Replan my blocks", () => {
    let preview = dragEntry(startPreview(proposal()), { id: ids.a, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-16T11:30:00.000Z", 15, LONDON);
    preview = removeEntry(preview, ids.c);
    preview = moveOverdue(preview, ids.o, LONDON);
    preview = chooseMiss(preview, ids.m, "outside", LONDON);
    assert.deepEqual(handPlaced(preview), [{ taskId: ids.a, at: "2026-11-16T11:30:00.000Z", durationMinutes: 15, moveDay: null }]);
    const again = carryOver(preview, { ...proposal(), replan: true }, LONDON);
    assert.equal(again.proposal.replan, true);
    assert.deepEqual(
      again.entries.map((entry) => [entry.taskId, entry.at]),
      [
        [ids.b, "2026-11-16T10:45:00.000Z"],
        [ids.a, "2026-11-16T11:30:00.000Z"],
        [ids.o, "2026-11-12T15:20:00.000Z"],
        [ids.m, "2026-11-16T17:30:00.000Z"],
      ].sort((left, right) => left[1].localeCompare(right[1])),
    );
    assert.deepEqual(again.removed, [ids.c]);
  });

  it("carries edits over to a different proposal, dropping drags for tasks no longer in it and keeping removals", () => {
    let preview = dragEntry(startPreview(proposal()), { id: ids.a, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-16T11:00:00.000Z", 15, LONDON);
    preview = dragEntry(preview, { id: ids.b, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-16T12:00:00.000Z", 15, LONDON);
    preview = removeEntry(preview, ids.c);
    const different: PlanProposal = {
      ...proposal(),
      placed: [
        { taskId: ids.a, workspaceId: "ws", title: "Call Ann", group: "call", at: "2026-11-16T11:00:00.000Z", durationMinutes: 15, suggested: false, moveDay: null },
        { taskId: ids.c, workspaceId: "ws", title: "Draft terms", group: "other", at: "2026-11-16T15:00:00.000Z", durationMinutes: 15, suggested: false, moveDay: null },
      ],
      replan: true,
    };
    const first = carryOver(preview, different, LONDON);
    assert.deepEqual(first.entries.map((entry) => [entry.taskId, entry.at, entry.byHand ?? false]), [[ids.a, "2026-11-16T11:00:00.000Z", true]], "Ben's drag goes with Ben, and Draft terms stays removed");
    const back = carryOver(first, { ...proposal(), replan: false }, LONDON);
    assert.deepEqual(back.removed, [ids.c], "removals survive a second toggle");
    assert.ok(!back.entries.some((entry) => entry.taskId === ids.c));
    const done = carryOver(first, { ...proposal(), placed: proposal().placed.filter((entry) => entry.taskId !== ids.a) }, LONDON);
    assert.ok(!done.entries.some((entry) => entry.taskId === ids.a), "a task gone from the plan, for example completed, isn't applied");
  });

  it("sends a chosen Couldn't fit time in the payload", () => {
    const outside = chooseMiss(startPreview(proposal()), ids.m, "outside", LONDON);
    assert.deepEqual(applyPayload(outside).find((entry) => entry.taskId === ids.m), { taskId: ids.m, at: "2026-11-16T17:30:00.000Z", durationMinutes: 120 });
    const next = chooseMiss(startPreview(proposal()), ids.m, "next", LONDON);
    assert.deepEqual(applyPayload(next).find((entry) => entry.taskId === ids.m), { taskId: ids.m, at: "2026-11-17T09:00:00.000Z", durationMinutes: 120, moveDay: "2026-11-17" });
  });

  it("flags a proposal over another proposal or a real block, but not over free, declined, all-day or touching events", () => {
    const tasks = [task(ids.a, "Call Ann"), task(ids.b, "Call Ben"), task(ids.c, "Draft terms")];
    const overlapping = dragEntry(startPreview(proposal()), { id: ids.c, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-16T10:35:00.000Z", 15, LONDON);
    const clashes = previewBlocks(overlapping, tasks, {}).map((block) => [block.task.id, block.clash]);
    assert.deepEqual(clashes, [
      [ids.a, "Draft terms"],
      [ids.c, "Call Ann"],
      [ids.b, "Draft terms"],
    ]);
    const real = previewBlocks(startPreview(proposal()), tasks, { blocks: [{ title: "Email Oliver", startsAt: "2026-11-16T14:05:00.000Z", endsAt: "2026-11-16T14:20:00.000Z" }] });
    assert.equal(real.find((block) => block.task.id === ids.c)?.clash, "Email Oliver");
    const quiet = [
      { subject: "Free", startsAt: "2026-11-16T10:30:00.000Z", endsAt: "2026-11-16T11:00:00.000Z", isAllDay: false, showAs: "free" },
      { subject: "Declined", startsAt: "2026-11-16T10:30:00.000Z", endsAt: "2026-11-16T11:00:00.000Z", isAllDay: false, showAs: "busy", myResponse: "declined" },
      { subject: "All day", startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-17T00:00:00.000Z", isAllDay: true, showAs: "busy" },
      { subject: "Touching", startsAt: "2026-11-16T10:00:00.000Z", endsAt: "2026-11-16T10:30:00.000Z", isAllDay: false, showAs: "busy" },
      { subject: "After", startsAt: "2026-11-16T14:15:00.000Z", endsAt: "2026-11-16T15:00:00.000Z", isAllDay: false, showAs: "busy" },
    ];
    assert.deepEqual(previewBlocks(startPreview(proposal()), tasks, { meetings: quiet }).map((block) => block.clash), [null, null, null]);
  });

  it("shows a clash for proposals, dragged ones included, against the meetings loaded now", () => {
    const tasks = [task(ids.a, "Call Ann"), task(ids.b, "Call Ben"), task(ids.c, "Draft terms")];
    const meetings = [{ subject: "Halden weekly", startsAt: "2026-11-16T10:40:00.000Z", endsAt: "2026-11-16T11:00:00.000Z", isAllDay: false, showAs: "busy" }];
    const blocks = previewBlocks(startPreview(proposal()), tasks, { meetings });
    assert.deepEqual(
      blocks.map((block) => [block.task.id, block.clash]),
      [
        [ids.a, "Halden weekly"],
        [ids.b, "Halden weekly"],
        [ids.c, null],
      ],
    );
    const dragged = dragEntry(startPreview(proposal()), { id: ids.c, dueAt: "2026-11-16T00:00:00.000Z", dueHasTime: false }, "2026-11-16T10:30:00.000Z", 15, LONDON);
    assert.equal(previewBlocks(dragged, tasks, { meetings }).find((block) => block.task.id === ids.c)?.clash, "Halden weekly");
    assert.ok(previewBlocks(dragged, tasks, { meetings }).every((block) => block.proposed));
  });
});
