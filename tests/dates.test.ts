import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CrmError } from "@/lib/crm/errors";
import { activityQueryFromSearchParams } from "@/lib/crm/validation";
import { instantDateLabel } from "@/lib/date-input";
import { parseDateTime, readDateTime, readDay } from "@/lib/time";

const LONDON = "Europe/London";

function iso(value: string) {
  const reading = readDateTime(value, LONDON);
  assert.ok(reading.ok, `${value}: ${reading.ok ? "" : reading.error}`);
  return reading.date.toISOString();
}

function refused(value: string, pattern: RegExp) {
  const reading = readDateTime(value, LONDON);
  assert.ok(!reading.ok, value);
  assert.match(reading.error, pattern, value);
}

describe("reading dates people and agents type", () => {
  it("reads bare dates and local times as London time on both sides of summer time", () => {
    assert.equal(iso("2026-03-28"), "2026-03-28T00:00:00.000Z");
    assert.equal(iso("2026-03-30"), "2026-03-29T23:00:00.000Z");
    assert.equal(iso("2026-07-01T00:30"), "2026-06-30T23:30:00.000Z");
    assert.equal(iso("2026-10-24T23:30"), "2026-10-24T22:30:00.000Z");
    assert.equal(iso("2026-10-26 09:00"), "2026-10-26T09:00:00.000Z");
  });

  it("reads slash dates as day, month, year", () => {
    assert.equal(iso("07/11/2026"), "2026-11-07T00:00:00.000Z");
    assert.equal(iso("7/11/2026 14:30"), "2026-11-07T14:30:00.000Z");
    assert.equal(iso("01/07/2026 09:00"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("01.07.2026"), "2026-06-30T23:00:00.000Z");
    assert.equal(iso("2026/07/01"), "2026-06-30T23:00:00.000Z");
    assert.equal(readDay("07/11/2026", LONDON), "2026-11-07");
  });

  it("reads month names in London time", () => {
    assert.equal(iso("7 Nov 2026"), "2026-11-07T00:00:00.000Z");
    assert.equal(iso("Wednesday 1 July 2026, 09:00"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("July 1, 2026 9:00"), "2026-07-01T08:00:00.000Z");
  });

  it("keeps an explicit offset or zone as written", () => {
    assert.equal(iso("2026-07-01T09:00:00+02:00"), "2026-07-01T07:00:00.000Z");
    assert.equal(iso("2026-07-01T09:00Z"), "2026-07-01T09:00:00.000Z");
    assert.equal(iso("2026-07-01 09:00 UTC"), "2026-07-01T09:00:00.000Z");
    assert.equal(iso("2026-07-01T09:00+0100"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 09:00:00 GMT"), "2026-07-01T09:00:00.000Z");
  });

  it("reads dashes and dots in the same day, month, year order as slashes", () => {
    assert.equal(iso("07-11-2026"), "2026-11-07T00:00:00.000Z");
    assert.equal(iso("01-07-2026 09:00"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("01.07.2026 09.00"), "2026-07-01T08:00:00.000Z");
  });

  it("reads seconds and am or pm after a month name", () => {
    assert.equal(iso("Nov 7, 2026 14:30:15"), "2026-11-07T14:30:15.000Z");
    assert.equal(iso("7 Nov 2026 2:30pm"), "2026-11-07T14:30:00.000Z");
    assert.equal(iso("1 July 2026 9am"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("1 July 2026 12am"), "2026-06-30T23:00:00.000Z");
    assert.equal(iso("1 July 2026 12:15 pm"), "2026-07-01T11:15:00.000Z");
    refused("1 July 2026 13pm", /Enter a valid date and time/);
    refused("1 July 2026 9", /Enter a valid date and time/);
  });

  it("reads RFC 2822 dates with zone names as their fixed offsets", () => {
    assert.equal(iso("Sat, 07 Nov 2026 10:00:00 EST"), "2026-11-07T15:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 EDT"), "2026-07-01T14:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 CST"), "2026-07-01T16:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 CDT"), "2026-07-01T15:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 MST"), "2026-07-01T17:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 MDT"), "2026-07-01T16:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 PST"), "2026-07-01T18:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 PDT"), "2026-07-01T17:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 BST"), "2026-07-01T09:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 CET"), "2026-07-01T09:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 CEST"), "2026-07-01T08:00:00.000Z");
    assert.equal(iso("Wed, 01 Jul 2026 10:00:00 -0700"), "2026-07-01T17:00:00.000Z");
    assert.equal(iso("Thu Jul 02 2026 10:00:00 GMT+0100 (British Summer Time)"), "2026-07-02T09:00:00.000Z");
    assert.equal(iso("Sun, 25 Oct 2026 01:30:00 BST"), "2026-10-25T00:30:00.000Z");
    assert.equal(iso("Sun, 25 Oct 2026 01:30:00 GMT"), "2026-10-25T01:30:00.000Z");
    refused("Wed, 01 Jul 2026 10:00:00 AEST", /Enter a valid date and time/);
  });

  it("refuses ambiguous or impossible dates with a reason instead of guessing", () => {
    refused("07/11/26", /year in full/);
    refused("11/07", /Enter a valid date and time/);
    refused("next Tuesday-ish", /Enter a valid date and time/);
    refused("31/02/2026", /isn't a real date/);
    refused("2026-02-30T09:00", /isn't a real date and time/);
    refused("2026-02-30T10:00:00Z", /isn't a real date and time/);
    refused("2026-04-31T09:00:00+01:00", /isn't a real date and time/);
    refused("2026-03-29T01:30", /is skipped when the clocks go forward/);
    refused("2026-10-25T01:30", /happens twice when the clocks go back/);
    assert.equal(iso("2026-10-25T01:30+01:00"), "2026-10-25T00:30:00.000Z");
    assert.equal(iso("2026-10-25T01:30Z"), "2026-10-25T01:30:00.000Z");
    assert.equal(parseDateTime("07/11/26", LONDON), null);
    assert.equal(parseDateTime("July 11", LONDON), null);
  });

  it("turns an unreadable API date into a 400 that says why", () => {
    assert.throws(
      () => activityQueryFromSearchParams(new URLSearchParams({ from: "07/11/26" })),
      (error: unknown) => error instanceof CrmError && error.status === 400 && /year in full/.test(error.message),
    );
    const query = activityQueryFromSearchParams(new URLSearchParams({ from: "01/07/2026", to: "01/07/2026" }));
    assert.equal(query.from, "2026-06-30T23:00:00.000Z");
    assert.equal(query.to, "2026-07-01T23:00:00.000Z");
  });
});

describe("showing the day of an instant", () => {
  const now = new Date("2026-11-07T12:00:00Z");

  it("uses the London day, so a task due just after midnight in summer shows that day", () => {
    assert.equal(instantDateLabel("2026-07-01T23:30:00.000Z", now, LONDON), "Thu 2 Jul");
    assert.equal(instantDateLabel("2026-07-01T22:59:00.000Z", now, LONDON), "Wed 1 Jul");
    assert.equal(instantDateLabel("2026-03-29T00:30:00.000Z", now, LONDON), "Sun 29 Mar");
    assert.equal(instantDateLabel("2026-03-28T23:30:00.000Z", now, LONDON), "Sat 28 Mar");
    assert.equal(instantDateLabel("2026-10-24T23:30:00.000Z", now, LONDON), "Sun 25 Oct");
    assert.equal(instantDateLabel("2026-10-25T23:30:00.000Z", now, LONDON), "Sun 25 Oct");
    assert.equal(instantDateLabel("2027-07-01T23:30:00.000Z", now, LONDON), "Fri 2 Jul 2027");
    assert.equal(instantDateLabel("not a date", now, LONDON), "not a date");
  });
});
