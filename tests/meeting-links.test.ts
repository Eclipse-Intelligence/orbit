import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LinkedText from "@/components/_ui/linked-text";
import EventNotes from "@/components/crm/event-notes";
import { composeEmailHtml } from "@/lib/mail/html";
import {
  clipNotes,
  eventBodyText,
  findMeetingLink,
  joinLink,
  meetingLink,
  NOTES_MAX,
  safeUrl,
  unwrapSafeLink,
} from "@/lib/meeting-links";
import { textParts } from "@/lib/text-links";

function safeLink(target: string) {
  return `https://eur02.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=05%7C02%7Cx&sdata=abc&reserved=0`;
}

describe("meeting links", () => {
  it("recognises each provider", () => {
    const links = [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
      "https://teams.microsoft.com/meet/1234567890?p=abc",
      "https://teams.live.com/meet/9876543210",
      "https://us02web.zoom.us/j/81234567890?pwd=abc",
      "https://zoom.us/j/81234567890",
      "https://acme.zoom.us/my/mark.ridgeon",
      "https://meet.google.com/abc-defg-hij",
      "https://whereby.com/eclipse",
      "https://geteclipse.whereby.com/room",
      "https://acme.webex.com/acme/j.php?MTID=m123",
      "https://acme.webex.com/meet/jane",
      "https://meet.goto.com/123456789",
      "https://global.gotomeeting.com/join/123456789",
      "https://meet.jit.si/EclipseWeekly",
      "https://around.co/r/eclipse",
      "https://chime.aws/1234567890",
    ];
    for (const link of links) {
      assert.equal(meetingLink(`Join here: ${link}`), new URL(link).toString(), link);
    }
  });

  it("skips help, options and dial-in links from the same providers", () => {
    assert.equal(meetingLink("Need help? https://aka.ms/JoinTeamsMeeting"), null);
    assert.equal(meetingLink("https://teams.microsoft.com/meetingOptions/?organizerId=1"), null);
    assert.equal(meetingLink("Find your local number: https://us02web.zoom.us/u/kdIk"), null);
    assert.equal(meetingLink("https://help.webex.com/en-us/article/123"), null);
    assert.equal(meetingLink("https://meet.google.com/"), null);
    assert.equal(meetingLink("https://evil.example/meet.google.com"), null);
    assert.equal(meetingLink("https://zoom.us.evil.example/j/123"), null);
  });

  it("recognises the user's own meeting link", () => {
    const own = "https://meet.eclipse.example/mark";
    assert.equal(findMeetingLink(["Call on https://meet.eclipse.example/mark"]), null);
    assert.equal(findMeetingLink(["Call on https://meet.eclipse.example/mark."], { own }), "https://meet.eclipse.example/mark");
    assert.equal(findMeetingLink(["https://meet.eclipse.example/mark/room?x=1"], { own }), "https://meet.eclipse.example/mark/room?x=1");
    assert.equal(findMeetingLink(["https://meet.eclipse.example/markus"], { own }), null);
  });

  it("unwraps Outlook safe links", () => {
    const zoom = "https://us02web.zoom.us/j/81234567890?pwd=abc";
    assert.equal(unwrapSafeLink(safeLink(zoom)), zoom);
    assert.equal(unwrapSafeLink(safeLink(safeLink(zoom))), zoom);
    assert.equal(meetingLink(`Join Zoom Meeting\n${safeLink(zoom)}`), zoom);
    assert.equal(safeUrl(safeLink("https://example.com/doc")), "https://example.com/doc");
    assert.equal(safeUrl(safeLink("javascript:alert(1)")), null);
    assert.equal(eventBodyText(`Agenda: ${safeLink("https://example.com/doc?a=1&b=2")}`), "Agenda: https://example.com/doc?a=1&b=2");
  });

  it("takes the provided link, then the location, then the body", () => {
    const teams = "https://teams.microsoft.com/l/meetup-join/abc";
    const zoom = "https://zoom.us/j/111";
    const meet = "https://meet.google.com/aaa-bbbb-ccc";
    assert.equal(joinLink({ provided: [null, teams], location: zoom, notes: meet }), teams);
    assert.equal(joinLink({ provided: [null, undefined], location: `Online: ${zoom}`, notes: meet }), zoom);
    assert.equal(joinLink({ location: "Room 4", notes: `Agenda\nJoin: ${meet}\nNotes https://example.com/x` }), meet);
    assert.equal(joinLink({ location: "Room 4", notes: "Agenda only, see https://example.com/doc" }), null);
    assert.equal(joinLink({ location: null, notes: null }), null);
  });

  it("only allows http and https", () => {
    assert.equal(meetingLink("zoommtg://zoom.us/join?confno=81234567890"), null);
    assert.equal(meetingLink("msteams:/l/meetup-join/abc"), null);
    assert.equal(joinLink({ provided: ["javascript:alert(1)"], location: null, notes: null }), null);
    assert.equal(joinLink({ provided: ["data:text/html,hi"], location: null, notes: "https://zoom.us/j/5" }), "https://zoom.us/j/5");
    assert.equal(meetingLink("http://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
  });

  it("finds links in Outlook text bodies with angle brackets", () => {
    const body = [
      "Agenda: pricing",
      "________________________________________________________________________________",
      "Microsoft Teams Need help?<https://aka.ms/JoinTeamsMeeting?omkt=en-GB>",
      "Join the meeting now<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d>",
      "Meeting ID: 123 456 789",
      "For organisers: Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=1>",
    ].join("\r\n");
    assert.equal(
      joinLink({ location: "Microsoft Teams Meeting", notes: eventBodyText(body, "text") }),
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d",
    );
  });
});

describe("event notes", () => {
  it("turns HTML bodies into text and keeps link targets", () => {
    const html =
      '<html><body><p>Hi <b>all</b>,</p><p><a href="https://us02web.zoom.us/j/1?pwd=x&amp;y=2">Join Zoom Meeting</a></p>' +
      '<p><a href="https://example.com/doc">https://example.com/doc</a></p><script>alert(1)</script><a href="javascript:x()">bad</a></body></html>';
    const text = eventBodyText(html, "html")!;
    assert.match(text, /Hi all ,/);
    assert.match(text, /Join Zoom Meeting <https:\/\/us02web\.zoom\.us\/j\/1\?pwd=x&y=2>/);
    assert.match(text, /^https:\/\/example\.com\/doc$/m);
    assert.doesNotMatch(text, /<(?!https)|alert|javascript/);
    assert.equal(joinLink({ location: null, notes: text }), "https://us02web.zoom.us/j/1?pwd=x&y=2");
  });

  it("detects HTML in feed descriptions and tidies plain text", () => {
    assert.equal(eventBodyText('Join <a href="https://meet.google.com/abc-defg-hij">here</a><br>Bring notes'), "Join here <https://meet.google.com/abc-defg-hij>\nBring notes");
    assert.equal(eventBodyText("Line one  \r\n\r\n\r\n\r\nLine\u0000 two\t"), "Line one\n\nLine two");
    assert.equal(eventBodyText("   \n  "), null);
    assert.equal(eventBodyText(null), null);
  });

  it("caps long notes", () => {
    const long = `${"a".repeat(NOTES_MAX - 2)}😀😀 and more`;
    const clipped = clipNotes(long)!;
    assert.ok(clipped.length <= NOTES_MAX);
    assert.ok(clipped.endsWith("…"));
    assert.doesNotMatch(clipped, /[\uD800-\uDBFF]…$/);
    assert.equal(clipNotes("short"), "short");
    assert.equal(clipNotes(null), null);
  });
});

describe("text links", () => {
  it("splits URLs and email addresses", () => {
    assert.deepEqual(textParts("Mail jane@acme.com or see <https://acme.com/a>.", { emails: true }), [
      { kind: "text", text: "Mail " },
      { kind: "email", text: "jane@acme.com", href: "mailto:jane@acme.com" },
      { kind: "text", text: " or see <" },
      { kind: "url", text: "https://acme.com/a", href: "https://acme.com/a" },
      { kind: "text", text: ">." },
    ]);
    assert.deepEqual(textParts("jane@acme.com"), [{ kind: "text", text: "jane@acme.com" }]);
  });

  it("keeps the email linkify unchanged", () => {
    const html = composeEmailHtml({ body: 'See <https://acme.com/a> and "https://acme.com/b".', plain: true });
    assert.match(html, /&lt;<a href="https:\/\/acme\.com\/a">https:\/\/acme\.com\/a<\/a>&gt;/);
    assert.match(html, /&quot;<a href="https:\/\/acme\.com\/b">https:\/\/acme\.com\/b<\/a>&quot;/);
  });

  it("renders notes and locations with safe links and no HTML", () => {
    const markup = renderToStaticMarkup(
      createElement(LinkedText, { text: 'Room 4 <b>bold</b> https://zoom.us/j/1?a=1&b=2 ask jane@acme.com <script>x</script>' }),
    );
    assert.match(markup, /<a href="https:\/\/zoom\.us\/j\/1\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" class="[^"]+">https:\/\/zoom\.us\/j\/1\?a=1&amp;b=2<\/a>/);
    assert.match(markup, /<a href="mailto:jane@acme\.com" class="[^"]+">jane@acme\.com<\/a>/);
    assert.match(markup, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(markup, /&lt;script&gt;/);
    assert.doesNotMatch(markup, /<script|<b>/);
  });

  it("clamps the description until it is opened", () => {
    const markup = renderToStaticMarkup(createElement(EventNotes, { id: "e1", text: `Agenda\n${"Line\n".repeat(40)}https://zoom.us/j/1` }));
    assert.match(markup, /Description/);
    assert.match(markup, /id="event-notes-e1" class="[^"]*line-clamp-\[8\][^"]*whitespace-pre-line|id="event-notes-e1" class="[^"]*whitespace-pre-line[^"]*line-clamp-\[8\]/);
    assert.match(markup, /href="https:\/\/zoom\.us\/j\/1"/);
  });
});
