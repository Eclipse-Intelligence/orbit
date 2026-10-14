import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionStrength, formatWhen, relativeWhen } from "@/lib/companies";
import { companyHref, contactHref, legacyRecordHref, listHref, listQuery } from "@/lib/crm/hrefs";
import {
  legacyTasksHref,
  taskDueState,
  taskViewFromParam,
  tasksHref,
} from "@/lib/crm/task-views";
import { teamsCallUrl } from "@/lib/phone";
import { appTimeZone, dateTimeInputValue, dayWindow, startOfDay, toIsoInstant } from "@/lib/time";

const now = Date.parse("2026-10-05T12:00:00Z");

describe("connection strength", () => {
  it("maps recency onto the records-table scale", () => {
    assert.equal(connectionStrength(null, now), "none");
    assert.equal(connectionStrength(new Date(now - 3 * 86_400_000).toISOString(), now), "strong");
    assert.equal(connectionStrength(new Date(now - 20 * 86_400_000).toISOString(), now), "weak");
    assert.equal(connectionStrength(new Date(now - 80 * 86_400_000).toISOString(), now), "veryweak");
    assert.equal(relativeWhen(null, now), "No contact");
    assert.equal(relativeWhen(new Date(now - 3 * 86_400_000).toISOString(), now), "3 days ago");
    assert.equal(relativeWhen(new Date(now - 21 * 86_400_000).toISOString(), now), "3 weeks ago");
  });
});

describe("configured time zone", () => {
  it("falls back to London for a missing or unknown zone", () => {
    const previous = process.env.NEXT_PUBLIC_TIMEZONE;
    try {
      delete process.env.NEXT_PUBLIC_TIMEZONE;
      assert.equal(appTimeZone(), "Europe/London");
      process.env.NEXT_PUBLIC_TIMEZONE = "Mars/Olympus";
      assert.equal(appTimeZone(), "Europe/London");
      assert.match(formatWhen("2026-07-01T08:30:00Z"), /^Jul 1, 2026, 9:30\sAM$/);
      process.env.NEXT_PUBLIC_TIMEZONE = "America/New_York";
      assert.equal(appTimeZone(), "America/New_York");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_TIMEZONE;
      else process.env.NEXT_PUBLIC_TIMEZONE = previous;
    }
  });

  it("reads wall-clock input in the zone across daylight saving changes", () => {
    assert.equal(toIsoInstant("2026-03-28T09:00", "Europe/London"), "2026-03-28T09:00:00.000Z");
    assert.equal(toIsoInstant("2026-03-30T09:00", "Europe/London"), "2026-03-30T08:00:00.000Z");
    assert.equal(toIsoInstant("2026-03-29T01:30", "Europe/London"), "2026-03-29T01:30:00.000Z");
    assert.equal(toIsoInstant("2026-10-25T00:30", "Europe/London"), "2026-10-24T23:30:00.000Z");
    assert.equal(toIsoInstant("2026-03-07T09:00", "America/Los_Angeles"), "2026-03-07T17:00:00.000Z");
    assert.equal(toIsoInstant("2026-03-09T09:00", "America/Los_Angeles"), "2026-03-09T16:00:00.000Z");
    assert.equal(toIsoInstant("2026-03-08T02:30", "America/Los_Angeles"), "2026-03-08T10:30:00.000Z");
    assert.equal(toIsoInstant("2026-11-02T09:00", "America/Los_Angeles"), "2026-11-02T17:00:00.000Z");
    assert.equal(toIsoInstant("2026-07-01T09:00:00+02:00", "America/Los_Angeles"), "2026-07-01T07:00:00.000Z");
    assert.equal(toIsoInstant("2026-07-01T09:00Z", "America/Los_Angeles"), "2026-07-01T09:00:00.000Z");
    assert.equal(toIsoInstant("2026-02-30T09:00", "Europe/London"), null);
    assert.equal(toIsoInstant("soon", "Europe/London"), null);
  });

  it("fills a datetime-local input in the zone", () => {
    assert.equal(dateTimeInputValue("2026-03-30T08:00:00.000Z", "Europe/London"), "2026-03-30T09:00");
    assert.equal(dateTimeInputValue("2026-01-15T08:00:00.000Z", "Europe/London"), "2026-01-15T08:00");
    assert.equal(dateTimeInputValue("2026-11-02T17:00:00.000Z", "America/Los_Angeles"), "2026-11-02T09:00");
    assert.equal(dateTimeInputValue(null, "UTC"), "");
  });

  it("cuts today at local midnight, including 23 and 25 hour days", () => {
    const spring = dayWindow(new Date("2026-03-29T12:00:00Z"), "Europe/London");
    assert.equal(spring.start.toISOString(), "2026-03-29T00:00:00.000Z");
    assert.equal(spring.end.toISOString(), "2026-03-29T23:00:00.000Z");
    const autumn = dayWindow(new Date("2026-11-01T20:00:00Z"), "America/Los_Angeles");
    assert.equal(autumn.start.toISOString(), "2026-11-01T07:00:00.000Z");
    assert.equal(autumn.end.toISOString(), "2026-11-02T08:00:00.000Z");
    const lateEvening = dayWindow(new Date("2026-07-02T05:00:00Z"), "America/Los_Angeles");
    assert.equal(lateEvening.start.toISOString(), "2026-07-01T07:00:00.000Z");
    assert.equal(startOfDay(new Date("2026-07-02T05:00:00Z"), "UTC").toISOString(), "2026-07-02T00:00:00.000Z");
  });
});

describe("call links", () => {
  it("builds a Teams call link only for a usable number", () => {
    assert.equal(teamsCallUrl("07700 900123"), "msteams:/l/call/0/0?users=4:%2B447700900123");
    assert.equal(teamsCallUrl("+1 (555) 010-0100"), "msteams:/l/call/0/0?users=4:%2B15550100100");
    assert.equal(teamsCallUrl("ext 12"), null);
    assert.equal(teamsCallUrl(""), null);
    assert.equal(teamsCallUrl(null), null);
  });
});

describe("record links", () => {
  it("points records at their own pages", () => {
    const id = "6f1c2a4e-0b7d-4c55-9a3e-2d8f1b6c7e90";
    assert.equal(companyHref(id), `/companies/${id}`);
    assert.equal(contactHref(id), `/contacts/${id}`);
    assert.equal(contactHref("a/b?c"), "/contacts/a%2Fb%3Fc");
  });

  it("returns to the list with its last query, minus old sheet params", () => {
    assert.equal(listHref("companies"), "/");
    assert.equal(listHref("contacts", null), "/contacts");
    assert.equal(listHref("companies", "?q=acme&page=2"), "/?q=acme&page=2");
    assert.equal(listHref("contacts", "q=jane&contact=abc"), "/contacts?q=jane");
    assert.equal(listQuery("?record=abc"), "");
    assert.equal(listQuery("owner=me&record=abc&lifecycle=lead"), "?owner=me&lifecycle=lead");
  });

  it("redirects the old sheet links to the record pages", () => {
    assert.equal(legacyRecordHref("/", new URLSearchParams("record=abc&q=x")), "/companies/abc");
    assert.equal(legacyRecordHref("/contacts", new URLSearchParams("contact=xyz")), "/contacts/xyz");
    assert.equal(legacyRecordHref("/", new URLSearchParams("contact=xyz")), null);
    assert.equal(legacyRecordHref("/contacts", new URLSearchParams("record=abc")), null);
    assert.equal(legacyRecordHref("/inbox", new URLSearchParams("record=abc")), null);
  });
});

describe("tasks page links", () => {
  it("redirects /actions to /tasks and keeps the query string", () => {
    assert.equal(legacyTasksHref("/actions", new URLSearchParams()), "/tasks");
    assert.equal(legacyTasksHref("/actions/", new URLSearchParams()), "/tasks");
    assert.equal(legacyTasksHref("/actions", new URLSearchParams("view=today")), "/tasks?view=today");
    assert.equal(legacyTasksHref("/actions", new URLSearchParams("view=overdue&q=deck")), "/tasks?view=overdue&q=deck");
    assert.equal(legacyTasksHref("/actions", new URLSearchParams("view=none")), "/tasks?view=without-tasks");
    assert.equal(legacyTasksHref("/actions", new URLSearchParams("view=all")), "/tasks");
    assert.equal(legacyTasksHref("/actions", new URLSearchParams("view=bogus&q=x")), "/tasks?q=x");
    assert.equal(legacyTasksHref("/tasks", new URLSearchParams("view=none")), null);
    assert.equal(legacyTasksHref("/actionsx", new URLSearchParams()), null);
  });

  it("reads and writes the view in the tasks URL", () => {
    assert.equal(tasksHref(), "/tasks");
    assert.equal(tasksHref("all"), "/tasks");
    assert.equal(tasksHref("today"), "/tasks?view=today");
    assert.equal(tasksHref("none"), "/tasks?view=without-tasks");
    assert.equal(taskViewFromParam("without-tasks"), "none");
    assert.equal(taskViewFromParam("none"), "none");
    assert.equal(taskViewFromParam("upcoming"), "upcoming");
    assert.equal(taskViewFromParam("later"), null);
    assert.equal(taskViewFromParam(undefined), null);
  });

  it("labels a task's due state in London time", () => {
    const at = Date.parse("2026-10-05T12:00:00Z");
    const zone = "Europe/London";
    assert.deepEqual(taskDueState(null, at, zone), { kind: "none", label: "No date" });
    assert.deepEqual(taskDueState("2026-10-04T22:59:00Z", at, zone), { kind: "overdue", label: "Overdue" });
    assert.deepEqual(taskDueState("2026-10-04T23:00:00Z", at, zone), { kind: "today", label: "Today" });
    assert.deepEqual(taskDueState("2026-10-05T22:59:00Z", at, zone), { kind: "today", label: "Today" });
    assert.deepEqual(taskDueState("2026-10-08T09:00:00Z", at, zone), { kind: "later", label: "Thu 8 Oct" });
    assert.deepEqual(taskDueState("2027-01-12T09:00:00Z", at, zone), { kind: "later", label: "12 Jan 2027" });
  });
});
