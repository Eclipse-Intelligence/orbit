import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { FEED_CALENDAR_ID, syncCalendar } from "@/lib/crm/calendar";
import { connectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { addCalendarFeed, FEED_DUPLICATE } from "@/lib/crm/calendar-feeds";
import { listCalendarGroups, listCalendarItems, setCalendarVisible } from "@/lib/crm/calendars";
import { backgroundTargets } from "@/lib/crm/conversations";
import { DEFAULT_STEPS } from "@/lib/crm/scheduler";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { meetingLink, readFeed } from "@/lib/ical/events";
import {
  assertPublicHost,
  FEED_MAX_BYTES,
  fetchFeed,
  isPublicAddress,
  maskFeedUrl,
  normalizeFeedUrl,
  secureFeedFetch,
  type Lookup,
} from "@/lib/ical/fetch";
import { parseContentLine, parseDuration, resolveZone, unfoldLines } from "@/lib/ical/parse";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const WINDOW = { start: new Date(Date.UTC(2026, 9, 1)), end: new Date(Date.UTC(2027, 2, 1)) };
const SECRET_PATH = "/calendar/ical/me%40example.com/private-5ecret0token/basic.ics";
const FEED_URL = `https://calendar.google.com${SECRET_PATH}`;

type Call = { url: string; headers: Record<string, string> };

const publicLookup: Lookup = async (host) => {
  if (host.endsWith(".private.test")) return [{ address: "10.1.2.3", family: 4 }];
  if (host.endsWith(".metadata.test")) return [{ address: "169.254.169.254", family: 4 }];
  if (host.endsWith(".mixed.test")) {
    return [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ];
  }
  if (host.endsWith(".mapped.test")) return [{ address: "::ffff:127.0.0.1", family: 6 }];
  if (host.endsWith(".missing.test")) throw new Error("ENOTFOUND");
  return [{ address: "93.184.216.34", family: 4 }];
};

function ics(lines: string[], calendar: string[] = []) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...calendar, ...lines, "END:VCALENDAR"].join("\r\n");
}

function vevent(lines: string[]) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}

function headersOf(init?: RequestInit) {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function feedStub(routes: Record<string, (call: Call) => Response>, calls: Call[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, headers: headersOf(init) };
    calls.push(call);
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404 });
    return route(call);
  }) as typeof fetch;
}

function calendarResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/calendar", ...headers } });
}

function byId<T extends { providerEventId: string }>(events: T[]) {
  return new Map(events.map((event) => [event.providerEventId, event]));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  delete process.env.MICROSOFT_TENANT;
});

after(async () => {
  await getPool().end();
});

describe("calendar link safety", () => {
  it("accepts https and webcal links and rejects everything else", () => {
    assert.equal(
      normalizeFeedUrl(" webcal://p01-calendars.icloud.com/published/2/abc ").toString(),
      "https://p01-calendars.icloud.com/published/2/abc",
    );
    assert.equal(normalizeFeedUrl("webcals://example.com/a.ics#frag").toString(), "https://example.com/a.ics");
    assert.equal(normalizeFeedUrl(FEED_URL).toString(), FEED_URL);
    for (const bad of [
      "http://example.com/a.ics",
      "ftp://example.com/a.ics",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com/a.ics",
      "not a link",
      "",
    ]) {
      assert.throws(() => normalizeFeedUrl(bad), { name: "FeedError" }, bad);
    }
  });

  it("knows private, loopback and link-local addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "224.0.0.1",
      "not-an-ip",
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"]) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  it("resolves the host and refuses anything that points inside", async () => {
    await assertPublicHost("calendar.google.com", publicLookup);
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "[::1]",
      "10.0.0.8",
      "feed.private.test",
      "feed.metadata.test",
      "feed.mixed.test",
      "feed.mapped.test",
    ]) {
      await assert.rejects(assertPublicHost(host, publicLookup), /can't read calendars from/, host);
    }
    await assert.rejects(assertPublicHost("feed.missing.test", publicLookup), /Couldn't find feed\.missing\.test/);
  });

  it("re-checks every redirect hop and caps redirects", async () => {
    const calls: Call[] = [];
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    const fetchImpl = feedStub(
      {
        "https://a.example/cal.ics": redirect("https://feed.private.test/cal.ics"),
        "https://b.example/cal.ics": redirect("http://b.example/plain.ics"),
        "https://c.example/1": redirect("/2"),
        "https://c.example/2": redirect("/3"),
        "https://c.example/3": redirect("/4"),
        "https://c.example/4": redirect("/5"),
        "https://d.example/1": redirect("https://d.example/final.ics"),
        "https://d.example/final.ics": () => calendarResponse(ics([])),
      },
      calls,
    );
    await assert.rejects(
      fetchFeed(new URL("https://a.example/cal.ics"), { fetchImpl, lookup: publicLookup }),
      /can't read calendars from feed\.private\.test/,
    );
    assert.ok(!calls.some((call) => call.url.includes("private.test")));
    await assert.rejects(
      fetchFeed(new URL("https://b.example/cal.ics"), { fetchImpl, lookup: publicLookup }),
      /away from https/,
    );
    await assert.rejects(
      fetchFeed(new URL("https://c.example/1"), { fetchImpl, lookup: publicLookup }),
      /redirected too many times/,
    );
    const ok = await fetchFeed(new URL("https://d.example/1"), { fetchImpl, lookup: publicLookup });
    assert.equal(ok.status, "ok");
  });

  it("sends conditional headers, honours 304 and caps the size", async () => {
    const calls: Call[] = [];
    const fetchImpl = feedStub(
      {
        "https://e.example/cal.ics": (call) =>
          call.headers["if-none-match"] === '"v1"'
            ? new Response(null, { status: 304 })
            : calendarResponse(ics([]), { etag: '"v1"', "last-modified": "Tue, 13 Oct 2026 10:00:00 GMT" }),
        "https://e.example/huge.ics": () =>
          new Response("x", { status: 200, headers: { "content-length": String(FEED_MAX_BYTES + 1) } }),
        "https://e.example/stream.ics": () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR\r\n"));
                for (let index = 0; index < 11; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
                controller.close();
              },
            }),
          ),
        "https://e.example/page.html": () => new Response("<html>hello</html>", { status: 200 }),
        "https://e.example/gone.ics": () => new Response("gone", { status: 404 }),
      },
      calls,
    );
    const first = await fetchFeed(new URL("https://e.example/cal.ics"), { fetchImpl, lookup: publicLookup });
    assert.equal(first.status, "ok");
    assert.ok(first.status === "ok" && first.etag === '"v1"');
    const second = await fetchFeed(new URL("https://e.example/cal.ics"), {
      fetchImpl,
      lookup: publicLookup,
      etag: '"v1"',
      lastModified: "Tue, 13 Oct 2026 10:00:00 GMT",
    });
    assert.deepEqual(second, { status: "not_modified" });
    assert.equal(calls[1].headers["if-modified-since"], "Tue, 13 Oct 2026 10:00:00 GMT");
    await assert.rejects(
      fetchFeed(new URL("https://e.example/huge.ics"), { fetchImpl, lookup: publicLookup }),
      /10 MB/,
    );
    await assert.rejects(
      fetchFeed(new URL("https://e.example/stream.ics"), { fetchImpl, lookup: publicLookup }),
      /10 MB/,
    );
    await assert.rejects(
      fetchFeed(new URL("https://e.example/page.html"), { fetchImpl, lookup: publicLookup }),
      /didn't return a calendar/,
    );
    const gone = await fetchFeed(new URL("https://e.example/gone.ics"), { fetchImpl, lookup: publicLookup }).catch(
      (error: Error) => error,
    );
    assert.ok(gone instanceof Error);
    assert.match(gone.message, /HTTP 404/);
    assert.doesNotMatch(gone.message, /gone\.ics|e\.example/);
  });

  it("refuses loopback even when connecting directly", async () => {
    await assert.rejects(secureFeedFetch("https://localhost:9/cal.ics"), /can't read calendars from localhost/);
  });
});

describe("iCal parsing", () => {
  it("unfolds lines and reads quoted parameters", () => {
    assert.deepEqual(unfoldLines("SUMMARY:Long\r\n  title\r\n\t continued\r\nUID:1"), [
      "SUMMARY:Long title continued",
      "UID:1",
    ]);
    const property = parseContentLine(
      'ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED;DELEGATED-FROM="mailto:a@b.c","mailto:d@e.f":mailto:jane@acme.com',
    );
    assert.equal(property?.params.CN?.[0], "Doe, Jane");
    assert.deepEqual(property?.params["DELEGATED-FROM"], ["mailto:a@b.c", "mailto:d@e.f"]);
    assert.equal(property?.value, "mailto:jane@acme.com");
    assert.deepEqual(parseDuration("PT1H30M"), { ms: 90 * 60 * 1000, days: 0 });
    assert.deepEqual(parseDuration("P1W"), { ms: 7 * 24 * HOUR, days: 7 });
    assert.equal(parseDuration("P"), null);
    assert.equal(resolveZone("Europe/London"), "Europe/London");
    assert.equal(resolveZone("GMT Standard Time"), "Europe/London");
    assert.equal(resolveZone("/mozilla.org/20050126_1/America/New_York"), "America/New_York");
    assert.equal(resolveZone("Made Up Zone"), null);
  });

  it("maps all-day, zoned, UTC and floating events with people and links", () => {
    const feed = readFeed(
      ics(
        [
          ...vevent([
            "UID:all-day@test",
            "DTSTART;VALUE=DATE:20261020",
            "DTEND;VALUE=DATE:20261022",
            "SUMMARY:Offsite",
            "TRANSP:TRANSPARENT",
          ]),
          ...vevent([
            "UID:ny@test",
            "DTSTART;TZID=America/New_York:20261020T090000",
            "DTEND;TZID=America/New_York:20261020T100000",
            "SUMMARY:Call with \\, comma\\; and semi",
            "LOCATION:https://acme.zoom.us/j/123?pwd=x",
            "STATUS:TENTATIVE",
            "ORGANIZER;CN=Jane Doe:mailto:Jane@Acme.com",
            "ATTENDEE;CN=Raj;PARTSTAT=ACCEPTED;CUTYPE=INDIVIDUAL:mailto:raj@acme.com",
            "ATTENDEE;CN=Board Room;CUTYPE=RESOURCE;PARTSTAT=ACCEPTED:mailto:room@acme.com",
            "ATTENDEE;PARTSTAT=DECLINED;EMAIL=pat@newco.io:urn:uuid:1234",
            "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:raj@acme.com",
            "ATTENDEE;PARTSTAT=TENTATIVE;CN=sam@x.io:mailto:sam@x.io",
          ]),
          ...vevent([
            "UID:utc@test",
            "DTSTART:20261021T140000Z",
            "DURATION:PT45M",
            "SUMMARY:UTC",
            "DESCRIPTION:Agenda\\nJoin: https://meet.google.com/abc-defg-hij.\\nOther https://example.com/x",
            "URL:https://example.com/event/1",
            "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
          ]),
          ...vevent([
            "UID:floating@test",
            "DTSTART:20261022T090000",
            "DTEND:20261022T091500",
            "SUMMARY:Floating",
            "DESCRIPTION:no links here",
          ]),
          ...vevent(["UID:cancelled@test", "DTSTART:20261023T090000Z", "DTEND:20261023T100000Z", "STATUS:CANCELLED"]),
          ...vevent([
            "UID:windows@test",
            "DTSTART;TZID=Pacific Standard Time:20261023T090000",
            "DTEND;TZID=Pacific Standard Time:20261023T100000",
          ]),
          ...vevent([
            "UID:unknown@test",
            "DTSTART;TZID=Nowhere/Special:20261023T090000",
            "DTEND;TZID=Nowhere/Special:20261023T100000",
          ]),
          ...vevent(["UID:old@test", "DTSTART:20250101T090000Z", "DTEND:20250101T100000Z"]),
          ...vevent(["SUMMARY:No start"]),
        ],
        ["X-WR-CALNAME:Personal\\, mine", "X-WR-TIMEZONE:America/Los_Angeles", "X-APPLE-CALENDAR-COLOR:#1BADF8FF"],
      ),
      WINDOW,
    );
    assert.equal(feed.name, "Personal, mine");
    assert.equal(feed.color, "#1badf8");
    assert.equal(feed.complete, true);
    const events = byId(feed.events);
    assert.deepEqual([...events.keys()].sort(), [
      "all-day@test",
      "cancelled@test",
      "floating@test",
      "ny@test",
      "unknown@test",
      "utc@test",
      "windows@test",
    ]);
    const allDay = events.get("all-day@test")!;
    assert.equal(allDay.isAllDay, true);
    assert.equal(allDay.startsAt, "2026-10-20T00:00:00.000Z");
    assert.equal(allDay.endsAt, "2026-10-22T00:00:00.000Z");
    assert.equal(allDay.showAs, "free");
    const ny = events.get("ny@test")!;
    assert.equal(ny.startsAt, "2026-10-20T13:00:00.000Z");
    assert.equal(ny.endsAt, "2026-10-20T14:00:00.000Z");
    assert.equal(ny.subject, "Call with , comma; and semi");
    assert.equal(ny.showAs, "tentative");
    assert.equal(ny.onlineMeetingUrl, "https://acme.zoom.us/j/123?pwd=x");
    assert.deepEqual(ny.organizer, { name: "Jane Doe", email: "jane@acme.com" });
    assert.deepEqual(ny.attendees, [
      { name: "Raj", email: "raj@acme.com", response: "accepted" },
      { name: null, email: "pat@newco.io", response: "declined" },
      { name: null, email: "sam@x.io", response: "tentativelyAccepted" },
    ]);
    const utc = events.get("utc@test")!;
    assert.equal(utc.startsAt, "2026-10-21T14:00:00.000Z");
    assert.equal(utc.endsAt, "2026-10-21T14:45:00.000Z");
    assert.equal(utc.onlineMeetingUrl, "https://meet.google.com/abc-defg-hij");
    assert.equal(utc.webLink, "https://example.com/event/1");
    assert.equal(utc.showAs, "busy");
    assert.equal(events.get("floating@test")!.startsAt, "2026-10-22T16:00:00.000Z");
    assert.equal(events.get("floating@test")!.onlineMeetingUrl, null);
    assert.equal(events.get("floating@test")!.webLink, null);
    assert.equal(events.get("cancelled@test")!.isCancelled, true);
    assert.equal(events.get("windows@test")!.startsAt, "2026-10-23T16:00:00.000Z");
    assert.equal(events.get("unknown@test")!.startsAt, "2026-10-23T09:00:00.000Z");
  });

  it("finds meeting links in descriptions and ignores other links", () => {
    assert.equal(
      meetingLink("See https://example.com/doc", "Join https://teams.microsoft.com/l/meetup-join/19%3a.", null),
      "https://teams.microsoft.com/l/meetup-join/19%3a",
    );
    assert.equal(meetingLink("https://evil.example/meet.google.com"), null);
    assert.equal(meetingLink("http://meet.google.com/abc"), null);
  });

  it("rejects text that isn't a calendar", () => {
    assert.throws(() => readFeed("hello", WINDOW), { name: "IcsParseError" });
  });
});

describe("recurrence", () => {
  const window = { start: new Date(Date.UTC(2026, 9, 1)), end: new Date(Date.UTC(2027, 3, 30)) };

  function expand(lines: string[], extra: string[][] = [], range = window) {
    return readFeed(ics([...vevent(lines), ...extra.flatMap(vevent)]), range).events;
  }

  it("keeps the local time across both DST changes", () => {
    const events = expand([
      "UID:standup@test",
      "DTSTART;TZID=Europe/London:20261019T090000",
      "DTEND;TZID=Europe/London:20261019T091500",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270405T075959Z",
    ]);
    const starts = events.map((event) => event.startsAt);
    assert.equal(starts[0], "2026-10-19T08:00:00.000Z");
    assert.equal(starts[1], "2026-10-26T09:00:00.000Z");
    assert.ok(starts.includes("2027-03-22T09:00:00.000Z"));
    assert.ok(starts.includes("2027-03-29T08:00:00.000Z"));
    assert.equal(starts.at(-1), "2027-03-29T08:00:00.000Z");
    assert.equal(events[0].providerEventId, "standup@test/20261019T080000Z");
    assert.equal(events[0].icalUid, "standup@test/20261019T080000Z");
    assert.ok(
      events.every((event) => new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime() === 15 * 60 * 1000),
    );
  });

  it("applies EXDATE and RECURRENCE-ID overrides, including cancelled ones", () => {
    const events = expand(
      [
        "UID:sync@test",
        "DTSTART;TZID=America/New_York:20261005T100000",
        "DTEND;TZID=America/New_York:20261005T110000",
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE;TZID=America/New_York:20261006T100000,20261007T100000",
        "SUMMARY:Daily",
      ],
      [
        [
          "UID:sync@test",
          "RECURRENCE-ID;TZID=America/New_York:20261008T100000",
          "DTSTART;TZID=America/New_York:20261008T150000",
          "DTEND;TZID=America/New_York:20261008T153000",
          "SUMMARY:Moved",
        ],
        [
          "UID:sync@test",
          "RECURRENCE-ID:20261009T140000Z",
          "DTSTART:20261009T140000Z",
          "DTEND:20261009T150000Z",
          "STATUS:CANCELLED",
          "SUMMARY:Daily",
        ],
      ],
    );
    const ids = events.map((event) => [event.providerEventId, event.subject, event.startsAt, event.isCancelled]);
    assert.deepEqual(ids, [
      ["sync@test/20261005T140000Z", "Daily", "2026-10-05T14:00:00.000Z", false],
      ["sync@test/20261008T140000Z", "Moved", "2026-10-08T19:00:00.000Z", false],
      ["sync@test/20261009T140000Z", "Daily", "2026-10-09T14:00:00.000Z", true],
    ]);
  });

  it("expands monthly and yearly rules with ordinals, month days and set positions", () => {
    const lastFriday = expand(["UID:lf@test", "DTSTART;VALUE=DATE:20261030", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4"]);
    assert.deepEqual(
      lastFriday.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-30", "2026-11-27", "2026-12-25", "2027-01-29"],
    );
    assert.ok(lastFriday.every((event) => event.isAllDay));
    const secondMonday = expand([
      "UID:sm@test",
      "DTSTART:20261012T090000Z",
      "DTEND:20261012T100000Z",
      "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO",
    ]);
    assert.deepEqual(
      secondMonday.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-12", "2026-12-14", "2027-02-08", "2027-04-12"],
    );
    const monthEnd = expand([
      "UID:me@test",
      "DTSTART:20261031T170000Z",
      "DTEND:20261031T173000Z",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20270228T235959Z",
    ]);
    assert.deepEqual(
      monthEnd.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"],
    );
    const lastWorkday = expand([
      "UID:lw@test",
      "DTSTART:20261030T160000Z",
      "DTEND:20261030T170000Z",
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
    ]);
    assert.deepEqual(
      lastWorkday.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-30", "2026-11-30", "2026-12-31"],
    );
    const yearly = expand([
      "UID:y@test",
      "DTSTART;TZID=Europe/London:20250330T100000",
      "DTEND;TZID=Europe/London:20250330T110000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    ]);
    assert.deepEqual(
      yearly.map((event) => event.startsAt),
      ["2027-03-28T09:00:00.000Z"],
    );
    const birthday = expand([
      "UID:b@test",
      "DTSTART;VALUE=DATE:19900215",
      "DTEND;VALUE=DATE:19900216",
      "RRULE:FREQ=YEARLY",
    ]);
    assert.deepEqual(
      birthday.map((event) => event.providerEventId),
      ["b@test/20270215"],
    );
    const weekdays = expand([
      "UID:wd@test",
      "DTSTART:20261001T080000Z",
      "DTEND:20261001T081500Z",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4",
    ]);
    assert.deepEqual(
      weekdays.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-01", "2026-10-13", "2026-10-15", "2026-10-27"],
    );
  });

  it("only keeps instances inside the window and stops runaway rules", () => {
    const old = expand(["UID:old@test", "DTSTART:20100101T090000Z", "DTEND:20100101T091500Z", "RRULE:FREQ=DAILY"], [], {
      start: new Date(Date.UTC(2026, 9, 1)),
      end: new Date(Date.UTC(2026, 9, 4)),
    });
    assert.deepEqual(
      old.map((event) => event.startsAt.slice(0, 10)),
      ["2026-10-01", "2026-10-02", "2026-10-03"],
    );
    const counted = expand(["UID:c@test", "DTSTART:20100101T090000Z", "RRULE:FREQ=DAILY;COUNT=10"]);
    assert.equal(counted.length, 0);
    const unsupported = expand(["UID:u@test", "DTSTART:20261002T090000Z", "RRULE:FREQ=HOURLY;COUNT=5"]);
    assert.deepEqual(
      unsupported.map((event) => event.providerEventId),
      ["u@test"],
    );
    const busy = readFeed(
      ics(vevent(["UID:busy@test", "DTSTART:20261001T000000Z", "DTEND:20261001T000100Z", "RRULE:FREQ=DAILY"])),
      { start: new Date(Date.UTC(2026, 9, 1)), end: new Date(Date.UTC(2032, 0, 1)) },
    );
    assert.equal(busy.events.length, 1000);
    assert.equal(busy.complete, false);
  });
});

describe("calendar link sync", () => {
  let owner: UserActor;
  let calls: Call[];
  let feedBody: string;
  let feedStatus: number;
  let feedFetch: typeof fetch;

  function feedEvents() {
    return ics(
      [
        ...vevent([
          "UID:weekly@test",
          "DTSTART;TZID=Europe/London:20261012T093000",
          "DTEND;TZID=Europe/London:20261012T100000",
          "RRULE:FREQ=WEEKLY;COUNT=3",
          "SUMMARY:Weekly",
          "ATTENDEE;CN=Jane:mailto:jane@acme.com",
        ]),
        ...vevent([
          "UID:lunch@test",
          "DTSTART:20261016T120000Z",
          "DTEND:20261016T130000Z",
          "SUMMARY:Lunch",
          "X-GOOGLE-CONFERENCE:https://meet.google.com/aaa-bbbb-ccc",
        ]),
      ],
      ["X-WR-CALNAME:me@example.com"],
    );
  }

  async function feedRows(userId: string) {
    const result = await getAdminPool().query<{
      id: string;
      provider: string;
      email: string | null;
      feed_url_cipher: string;
      feed_host: string;
      feed_etag: string | null;
      last_error: string | null;
      last_synced_at: Date | null;
    }>(
      `select id, provider, email, feed_url_cipher, feed_host, feed_etag, last_error, last_synced_at
       from crm.calendar_accounts where user_id = $1 and provider = 'ics' order by created_at`,
      [userId],
    );
    return result.rows;
  }

  async function feedEventRows(userId: string) {
    const result = await getAdminPool().query<{
      provider_event_id: string;
      subject: string;
      online_meeting_url: string | null;
    }>(
      `select e.provider_event_id, e.subject, e.online_meeting_url
       from crm.calendar_events e join crm.calendar_accounts a on a.id = e.account_id
       where e.user_id = $1 and a.provider = 'ics' order by e.starts_at`,
      [userId],
    );
    return result.rows;
  }

  before(async () => {
    owner = await createUser("feeds@orbit-feeds.test", "Feeds");
  });

  beforeEach(async () => {
    calls = [];
    feedBody = feedEvents();
    feedStatus = 200;
    feedFetch = feedStub(
      {
        [FEED_URL]: (call) => {
          if (feedStatus !== 200) return new Response("nope", { status: feedStatus });
          if (call.headers["if-none-match"] === '"etag-1"') return new Response(null, { status: 304 });
          return calendarResponse(feedBody, { etag: '"etag-1"' });
        },
        "https://calendar.google.com/broken.ics": () => new Response("missing", { status: 404 }),
      },
      calls,
    );
    await getAdminPool().query("update crm.calendar_accounts set last_attempt_at = null");
  });

  it("adds a calendar link, keeps the link secret and syncs its events", async () => {
    const added = await addCalendarFeed(
      owner,
      { url: FEED_URL.replace("https://", "webcal://"), name: "" },
      { feedFetch, lookup: publicLookup, now: NOW },
    );
    assert.equal(added.name, "me@example.com");
    assert.equal(added.host, "calendar.google.com");
    const [row] = await feedRows(owner.userId);
    assert.equal(row.provider, "ics");
    assert.equal(row.email, null);
    assert.doesNotMatch(row.feed_url_cipher, /5ecret0token|google/);
    assert.equal(decryptSecret(row.feed_url_cipher), FEED_URL);
    assert.equal(row.feed_etag, '"etag-1"');
    assert.ok(row.last_synced_at);
    const calendar = await getAdminPool().query<{
      provider_calendar_id: string;
      name: string;
      use_for_crm: boolean;
      is_visible: boolean;
    }>("select provider_calendar_id, name, use_for_crm, is_visible from crm.calendars where account_id = $1", [row.id]);
    assert.deepEqual(calendar.rows, [
      { provider_calendar_id: FEED_CALENDAR_ID, name: "me@example.com", use_for_crm: false, is_visible: true },
    ]);
    const events = await feedEventRows(owner.userId);
    assert.deepEqual(
      events.map((event) => event.provider_event_id),
      ["weekly@test/20261012T083000Z", "lunch@test", "weekly@test/20261019T083000Z", "weekly@test/20261026T093000Z"],
    );
    assert.equal(events[1].online_meeting_url, "https://meet.google.com/aaa-bbbb-ccc");

    const groups = await listCalendarGroups(owner);
    const group = groups.find((item) => item.provider === "ics")!;
    assert.equal(group.label, maskFeedUrl("calendar.google.com"));
    assert.equal(group.label, "calendar.google.com/…");
    assert.equal(group.connected, true);
    assert.doesNotMatch(JSON.stringify(groups), /5ecret0token|basic\.ics|ical\//);
    const items = await listCalendarItems(owner, {
      start: new Date(Date.UTC(2026, 9, 12)),
      end: new Date(Date.UTC(2026, 9, 20)),
    });
    assert.equal(items.filter((item) => item.calendarId === group.calendars[0].id).length, 3);
  });

  it("refuses duplicates, private hosts and links that don't work, leaving nothing behind", async () => {
    await assert.rejects(addCalendarFeed(owner, { url: FEED_URL }, { feedFetch, lookup: publicLookup, now: NOW }), {
      message: FEED_DUPLICATE,
    });
    await assert.rejects(
      addCalendarFeed(
        owner,
        { url: "https://feed.private.test/cal.ics" },
        { feedFetch, lookup: publicLookup, now: NOW },
      ),
      /can't read calendars from feed\.private\.test/,
    );
    await assert.rejects(
      addCalendarFeed(
        owner,
        { url: "http://calendar.google.com/x.ics" },
        { feedFetch, lookup: publicLookup, now: NOW },
      ),
      /https:\/\/ or webcal:\/\//,
    );
    await assert.rejects(
      addCalendarFeed(
        owner,
        { url: "https://calendar.google.com/broken.ics" },
        { feedFetch, lookup: publicLookup, now: NOW },
      ),
      /stopped working \(HTTP 404\)/,
    );
    assert.equal((await feedRows(owner.userId)).length, 1);
    assert.ok(!calls.some((call) => call.url.includes("private.test")));
  });

  it("does nothing new on 304 and refetches fully after a few hours", async () => {
    const before = await feedEventRows(owner.userId);
    const result = await syncCalendar(owner, { feedFetch, lookup: publicLookup, now: NOW + HOUR, force: true });
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["if-none-match"], '"etag-1"');
    assert.equal(result.saved, 0);
    assert.deepEqual(await feedEventRows(owner.userId), before);

    feedBody = feedEvents().replace("SUMMARY:Lunch", "SUMMARY:Long lunch");
    calls.length = 0;
    await syncCalendar(owner, { feedFetch, lookup: publicLookup, now: NOW + 7 * HOUR, force: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["if-none-match"], undefined);
    assert.ok((await feedEventRows(owner.userId)).some((event) => event.subject === "Long lunch"));
  });

  it("records failures on the account and keeps the events", async () => {
    feedStatus = 500;
    const result = await syncCalendar(owner, { feedFetch, lookup: publicLookup, now: NOW + 20 * HOUR, force: true });
    assert.match(result.error ?? "", /HTTP 500/);
    const [row] = await feedRows(owner.userId);
    assert.match(row.last_error ?? "", /HTTP 500/);
    assert.equal((await feedEventRows(owner.userId)).length, 4);
    const group = (await listCalendarGroups(owner)).find((item) => item.provider === "ics")!;
    assert.match(group.lastError ?? "", /HTTP 500/);
    assert.equal(group.connected, true);

    feedStatus = 200;
    feedBody = ics([...vevent(["UID:x@test", "DTSTART:20261016T120000Z"])]).replace(
      "BEGIN:VEVENT",
      "BEGIN:VEVENT\r\nBEGIN:A\r\nBEGIN:B\r\nBEGIN:C\r\nBEGIN:D\r\nBEGIN:E\r\nBEGIN:F\r\nBEGIN:G\r\nBEGIN:H",
    );
    const broken = await syncCalendar(owner, { feedFetch, lookup: publicLookup, now: NOW + 21 * HOUR, force: true });
    assert.match(broken.error ?? "", /nested too deeply/);
    assert.match((await feedRows(owner.userId))[0].last_error ?? "", /nested too deeply/);
  });

  it("skips hidden calendars that aren't used for CRM", async () => {
    const group = (await listCalendarGroups(owner)).find((item) => item.provider === "ics")!;
    await setCalendarVisible(owner, group.calendars[0].id, false);
    const result = await syncCalendar(owner, { feedFetch, lookup: publicLookup, now: NOW + 30 * HOUR, force: true });
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 0);
    await setCalendarVisible(owner, group.calendars[0].id, true);
  });

  it("routes each account to its own provider", async () => {
    const graphCalls: string[] = [];
    await connectCalendarAccount(owner, { origin: "https://orbit.test", code: "code" }, (async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        return json({
          access_token: "acct-access",
          refresh_token: "acct-refresh",
          expires_in: 3600,
          scope: "https://graph.microsoft.com/Calendars.Read",
        });
      }
      return json({ mail: "feeds@side.test", userPrincipalName: "feeds@side.test", displayName: "Side" });
    }) as typeof fetch);
    const graph = (async (input: RequestInfo | URL) => {
      const url = String(input);
      graphCalls.push(url);
      if (!url.startsWith("https://graph.microsoft.com/")) throw new Error(`graph got ${url}`);
      if (new URL(url).pathname === "/v1.0/me/calendars") {
        return json({ value: [{ id: "side-default", name: "Calendar", isDefaultCalendar: true }] });
      }
      return json({ value: [] });
    }) as typeof fetch;
    const result = await syncCalendar(owner, {
      fetchImpl: graph,
      feedFetch,
      lookup: publicLookup,
      now: NOW + 40 * HOUR,
      force: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.calendars, 2);
    assert.ok(graphCalls.some((url) => url.includes("/calendarView")));
    assert.ok(graphCalls.every((url) => !url.includes("calendar.google.com")));
    assert.deepEqual(
      calls.map((call) => call.url),
      [FEED_URL],
    );
    const groups = await listCalendarGroups(owner);
    assert.deepEqual(groups.map((group) => group.provider).sort(), ["ics", "microsoft"]);
  });

  it("schedules calendar links without Microsoft and keeps them private", async () => {
    const solo = await createUser("solo@orbit-feeds.test", "Solo");
    await addCalendarFeed(
      solo,
      { url: "https://p01-calendars.icloud.com/published/2/solo", name: "Family" },
      {
        feedFetch: feedStub(
          { "https://p01-calendars.icloud.com/published/2/solo": () => calendarResponse(feedEvents()) },
          [],
        ),
        lookup: publicLookup,
        now: NOW,
      },
    );
    const groups = await listCalendarGroups(solo);
    assert.equal(groups[0].displayName, "Family");
    assert.equal(groups[0].calendars[0].name, "Family");
    assert.equal(groups[0].label, "p01-calendars.icloud.com/…");
    const saved = process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;
    try {
      const target = (await backgroundTargets()).find((item) => item.actor.userId === solo.userId);
      assert.ok(target);
      assert.equal(target.calendarFeeds, true);
      assert.equal(target.calendarAccounts, false);
      const step = DEFAULT_STEPS.find((item) => item.name === "calendar")!;
      assert.equal(step.applies({ ...target, granola: null }), true);
    } finally {
      process.env.MICROSOFT_CLIENT_ID = saved;
    }
    const theirs = await queryAsUser<{ total: number }>(
      owner.userId,
      "select count(*)::int as total from crm.calendar_accounts where user_id = $1",
      [solo.userId],
    );
    assert.equal(theirs[0].total, 0);
    const changed = await queryAsUser<{ id: string }>(
      owner.userId,
      "update crm.calendar_accounts set feed_host = 'x' where user_id = $1 returning id",
      [solo.userId],
    );
    assert.equal(changed.length, 0);
  });
});
