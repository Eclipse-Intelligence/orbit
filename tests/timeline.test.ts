import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityByline,
  activityDetails,
  activityDirection,
  activitySource,
  activityTitle,
  activityTime,
  activityWhen,
  callDuration,
  countKinds,
  dayKey,
  dayLabel,
  groupByDay,
} from "@/lib/crm/timeline";
import type { Activity } from "@/lib/crm/types";

const zone = "Europe/London";
const now = Date.parse("2026-10-14T15:00:00Z");

function activity(patch: Partial<Activity>): Activity {
  return {
    id: "a",
    workspaceId: "w",
    type: "note",
    title: null,
    body: null,
    occurredAt: "2026-10-14T13:05:00Z",
    companyId: null,
    companyName: null,
    contactId: null,
    contactName: null,
    opportunityId: null,
    opportunityName: null,
    actorUserId: null,
    actorAgentId: null,
    actorName: null,
    metadata: {},
    createdAt: "2026-10-14T13:05:00Z",
    ...patch,
  };
}

describe("timeline days", () => {
  it("labels days and times in London time", () => {
    assert.equal(dayLabel("2026-10-14T13:05:00Z", now, zone), "Today");
    assert.equal(dayLabel("2026-10-13T23:30:00Z", now, zone), "Today");
    assert.equal(dayLabel("2026-10-13T22:59:00Z", now, zone), "Yesterday");
    assert.equal(dayLabel("2026-10-12T09:00:00Z", now, zone), "Mon 12 Oct");
    assert.equal(
      dayLabel("2025-12-31T12:00:00Z", now, zone),
      "Wed 31 Dec 2025",
    );
    assert.equal(dayLabel("not a date", now, zone), "No date");
    assert.equal(
      activityWhen("2026-10-14T13:05:00Z", now, zone),
      "Today, 14:05",
    );
    assert.equal(
      activityWhen("2026-10-12T08:07:00Z", now, zone),
      "Mon 12 Oct, 09:07",
    );
    assert.equal(
      activityWhen("2026-01-20T08:07:00Z", now, zone),
      "Tue 20 Jan, 08:07",
    );
    assert.equal(activityTime("2026-10-14T13:05:00Z", zone), "14:05");
    assert.equal(activityTime("2026-01-20T08:07:00Z", zone), "08:07");
    assert.equal(dayKey("2026-10-13T23:30:00Z", zone), "2026-10-14");
  });

  it("groups newest first by London day", () => {
    const groups = groupByDay(
      [
        activity({ id: "old", occurredAt: "2026-10-12T09:00:00Z" }),
        activity({ id: "late", occurredAt: "2026-10-13T23:30:00Z" }),
        activity({ id: "noon", occurredAt: "2026-10-14T12:00:00Z" }),
        activity({ id: "eve", occurredAt: "2026-10-13T20:00:00Z" }),
      ],
      now,
      zone,
    );
    assert.deepEqual(
      groups.map((group) => [group.label, group.items.map((item) => item.id)]),
      [
        ["Today", ["noon", "late"]],
        ["Yesterday", ["eve"]],
        ["Mon 12 Oct", ["old"]],
      ],
    );
  });

  it("counts the filterable kinds", () => {
    assert.deepEqual(
      countKinds([
        activity({ type: "call" }),
        activity({ type: "call" }),
        activity({ type: "email" }),
        activity({ type: "research" }),
      ]),
      { all: 4, call: 2, email: 1, meeting: 0, note: 0 },
    );
  });
});

describe("timeline rows", () => {
  it("describes calls, emails and meetings", () => {
    const teams = activity({
      type: "call",
      title: "Call with Jane Doe",
      body: "Outgoing call · 4 min 12 s",
      metadata: {
        source: "microsoft_teams",
        direction: "outbound",
        durationSeconds: 252,
      },
    });
    assert.equal(activityDirection(teams), "Outgoing");
    assert.equal(callDuration(teams), "4 min 12 s");
    assert.equal(activitySource(teams), "Teams");
    assert.equal(activityDetails(teams).body, null);
    assert.equal(
      callDuration(activity({ type: "call", body: "Incoming call · 42 s" })),
      "42 s",
    );
    assert.equal(
      activityDirection(
        activity({ type: "call", body: "Incoming call · 42 s" }),
      ),
      "Incoming",
    );
    assert.equal(activityTitle(activity({ type: "call" })), "Call");
    assert.equal(
      activityTitle(activity({ type: "call", body: "Renewal check-in" })),
      "Renewal check-in",
    );
    assert.equal(
      activityTitle(activity({ type: "call", body: "Incoming call · 42 s" })),
      "Call",
    );

    assert.equal(
      activityDirection(
        activity({
          type: "email",
          metadata: { source: "microsoft", direction: "outbound" },
        }),
      ),
      "Sent",
    );
    assert.equal(
      activityDirection(
        activity({ type: "email", metadata: { source: "microsoft" } }),
      ),
      "Received",
    );
    assert.equal(
      activityDirection(
        activity({ type: "email", metadata: { source: "manual" } }),
      ),
      null,
    );

    const meeting = activity({
      type: "meeting",
      title: "Quarterly review",
      body: "Attendees: Jane Doe, Mark Ridgeon\nOpen in Granola: https://notes.granola.ai/d/1",
      metadata: {
        source: "granola",
        externalUrl: "https://notes.granola.ai/d/1",
      },
    });
    assert.deepEqual(activityDetails(meeting), {
      attendees: "Jane Doe, Mark Ridgeon",
      body: null,
    });
    assert.equal(activitySource(meeting), "Granola");
  });

  it("titles notes from their first line", () => {
    assert.equal(
      activityTitle(activity({ body: "\nLikes the demo\nFollow up" })),
      "Likes the demo",
    );
    assert.equal(
      activityTitle(activity({ title: "Pricing", body: "Body" })),
      "Pricing",
    );
    assert.equal(activityTitle(activity({})), "Note");
    assert.equal(activityDetails(activity({ body: "Short note" })).body, null);
    assert.equal(
      activityDetails(activity({ body: "First\nSecond" })).body,
      "First\nSecond",
    );
  });

  it("names who did it", () => {
    const mine = activity({ actorUserId: "me", actorName: "Mark Ridgeon" });
    assert.equal(activityByline(mine, "me"), "by Mark Ridgeon");
    assert.equal(
      activityByline(activity({ actorUserId: "me" }), "me"),
      "by You",
    );
    assert.equal(
      activityByline(activity({ actorUserId: "someone" }), "me"),
      null,
    );
    assert.equal(
      activityByline(
        activity({
          type: "email",
          actorName: "Mark Ridgeon",
          contactName: "Jane Doe",
          metadata: { source: "microsoft" },
        }),
        "me",
      ),
      "from Jane Doe",
    );
    assert.equal(
      activityByline(
        activity({
          type: "meeting",
          actorName: "Mark Ridgeon",
          metadata: { source: "granola" },
        }),
        "me",
      ),
      "recorded by Mark Ridgeon",
    );
    assert.equal(
      activityByline(
        activity({ actorAgentId: "agent", actorName: "Inbox agent" }),
      ),
      "by Inbox agent",
    );
  });
});
