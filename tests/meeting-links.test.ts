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
import { OUTLOOK_INVITE } from "./outlook-sample";

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

  it("rejects help, install and landing pages and prefers a real room anywhere", () => {
    const pages = [
      "https://meet.goto.com/install",
      "https://meet.google.com/about",
      "https://meet.google.com/tel/abc",
      "https://meet.google.com/",
      "https://whereby.com/information/tos",
      "https://whereby.com/pricing",
      "https://whereby.com/download",
      "https://meet.jit.si/static/privacy.html",
      "https://meet.jit.si/download",
      "https://help.webex.com/en-us/join/abc",
      "https://www.webex.com/downloads.html",
      "https://teams.microsoft.com/v2/",
      "https://teams.microsoft.com/meet-now",
      "https://teams.microsoft.com/",
      "https://teams.microsoft.com/meet/",
      "https://zoom.us/download",
      "https://zoom.us/j/",
      "https://zoom.us/terms",
      "https://gotomeeting.com/features",
      "https://app.chime.aws/",
      "https://chime.aws/download",
      "https://around.co/about",
      "https://8x8.vc/terms",
    ];
    for (const page of pages) assert.equal(meetingLink(page), null, page);
    assert.equal(meetingLink("New to GoTo? https://meet.goto.com/install then https://meet.goto.com/123456789"), "https://meet.goto.com/123456789");
    assert.equal(meetingLink("Help: https://whereby.com/information/tos", "Room: https://whereby.com/eclipse"), "https://whereby.com/eclipse");
    assert.equal(meetingLink("https://www1.gotomeeting.com/join/123456789"), "https://www1.gotomeeting.com/join/123456789");
    for (const link of [
      "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_x@thread.v2/0",
      "https://meet.google.com/abcdefghij",
      "https://chime.aws/eclipseweekly",
    ]) {
      assert.equal(meetingLink(link), new URL(link).toString(), link);
    }
    assert.equal(meetingLink("https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting"), "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting");
  });

  it("cuts markdown links and keeps own links exact at a site root", () => {
    assert.equal(meetingLink("[https://zoom.us/j/1](https://zoom.us/j/1)"), "https://zoom.us/j/1");
    assert.equal(findMeetingLink(["https://eclipse.example/blog/post"], { own: "https://eclipse.example" }), null);
    assert.equal(findMeetingLink(["https://eclipse.example/"], { own: "https://eclipse.example" }), "https://eclipse.example/");
    assert.equal(findMeetingLink(["https://rooms.example/r?id=2"], { own: "https://rooms.example/r?id=1" }), null);
    assert.equal(findMeetingLink(["https://rooms.example/r?id=1"], { own: "https://rooms.example/r?id=1" }), "https://rooms.example/r?id=1");
  });

  it("unwraps other link wrappers", () => {
    assert.equal(meetingLink("https://www.google.com/url?q=https://zoom.us/j/5&sa=D"), "https://zoom.us/j/5");
    assert.equal(meetingLink("https://urldefense.com/v3/__https://zoom.us/j/123__;!!abc"), "https://zoom.us/j/123");
    assert.equal(meetingLink("https://urldefense.proofpoint.com/v2/url?u=https-3A__zoom.us_j_123&d=x"), "https://zoom.us/j/123");
    assert.equal(meetingLink("https://www.google.evil/url?q=https://zoom.us/j/5"), null);
    assert.equal(meetingLink("https://www.google.co.uk/url?q=https://zoom.us/j/5"), "https://zoom.us/j/5");
    assert.equal(
      meetingLink(`https://eur02.safelinks.protection.outlook.com/?data=x&amp;Url=${encodeURIComponent("https://zoom.us/j/9")}`),
      "https://zoom.us/j/9",
    );
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
    assert.deepEqual(joinLink({ provided: [null, teams], location: zoom, notes: meet }), { url: teams, source: "provider" });
    assert.deepEqual(joinLink({ provided: [null, undefined], location: `Online: ${zoom}`, notes: meet }), { url: zoom, source: "location" });
    assert.deepEqual(joinLink({ location: "Room 4", notes: `Agenda\nJoin: ${meet}\nNotes https://example.com/x` }), { url: meet, source: "notes" });
    assert.equal(joinLink({ location: "Room 4", notes: "Agenda only, see https://example.com/doc" }), null);
    assert.equal(joinLink({ location: null, notes: null }), null);
  });

  it("only allows http and https", () => {
    assert.equal(meetingLink("zoommtg://zoom.us/join?confno=81234567890"), null);
    assert.equal(meetingLink("msteams:/l/meetup-join/abc"), null);
    assert.equal(joinLink({ provided: ["javascript:alert(1)"], location: null, notes: null }), null);
    assert.deepEqual(joinLink({ provided: ["data:text/html,hi"], location: null, notes: "https://zoom.us/j/5" }), { url: "https://zoom.us/j/5", source: "notes" });
    assert.equal(meetingLink("HTTPS://ZOOM.US/J/123"), "https://zoom.us/J/123");
    assert.equal(meetingLink(`http://zoom.us/j/1?pwd=${"a".repeat(1980)}`), null);
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
      joinLink({ location: "Microsoft Teams Meeting", notes: eventBodyText(body, "text") })?.url,
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d",
    );
  });
});

describe("event notes", () => {
  it("reads a real Outlook invite as the first version did", () => {
    assert.equal(
      eventBodyText(OUTLOOK_INVITE, "html"),
      [
        "Hi Mark,",
        "",
        "Looking forward to catching up on the renewal. Agenda:",
        "",
        "- Pricing for next year",
        "",
        "- Onboarding the new team",
        "",
        "Thanks,",
        "",
        "Cara",
        "",
        "_".repeat(80),
        "",
        "Microsoft Teams Need help? <https://aka.ms/JoinTeamsMeeting?omkt=en-GB>",
        "",
        "Join the meeting now <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d>",
        "",
        "Meeting ID: 345 678 901 234",
        "",
        "Passcode: aB3cD4",
        "",
        "_".repeat(80),
      ].join("\n"),
    );
    assert.equal(eventBodyText("<p>Hi all,<o:p></o:p></p><p><o:p>&nbsp;</o:p></p>", "html"), "Hi all,");
    assert.equal(eventBodyText("<!DOCTYPE html><html><body>Agenda</body></html>", "html"), "Agenda");
    assert.equal(eventBodyText('<?xml version="1.0"?><p><![if !supportLists]>1.<![endif]> One</p><my-widget>x</my-widget>', "html"), "1. One\nx");
    assert.equal(eventBodyText("<p>  spaced   out  </p>", "html"), "spaced out");
    assert.equal(eventBodyText("Mail <mark@example.com> or <https://zoom.us/j/1><br>bye"), "Mail <mark@example.com> or <https://zoom.us/j/1>\nbye");
  });

  it("never splits a character or a link at the caps", () => {
    const emoji = eventBodyText(`<p>hi</p><!-- ${"x".repeat(199_981)} -->\u{1F600} tail`, "html")!;
    assert.equal(emoji, "hi");
    const split = eventBodyText(`${"a".repeat(199_999)}\u{1F600}`, "text")!;
    assert.doesNotMatch(split, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const words = `${"word ".repeat(39_995)}https://us02web.zoom.us/j/84529173006?pwd=abc`;
    assert.equal(joinLink({ notes: eventBodyText(words, "text") }), null);
    const clipped = clipNotes(`${"a".repeat(NOTES_MAX - 2)}\u{1F600}\u{1F600}`)!;
    assert.doesNotMatch(clipped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.equal(eventBodyText("x\uD800y"), "xy");
  });

  it("stays fast on hostile descriptions", () => {
    const size = 200_000;
    const fill = (piece: string) => piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
    const hostile = [
      fill('<a href="https://x.example/">x '),
      fill('<a href="'),
      fill("<a "),
      fill("<!--"),
      fill("<"),
      fill("<style>"),
      fill("<p "),
      fill("https://zoom.us/j/"),
      fill("https://"),
      fill("a.b-c_d%e"),
      `<p>${fill(" ")}</p>`,
      fill("&#x"),
      fill("a@b."),
      `<a href="https://x.example/">${fill("https://zoom.us/j/1?")}`,
      fill("<a href='https://x.example/' "),
    ];
    for (const body of hostile) {
      const started = performance.now();
      const text = eventBodyText(`<div>${body}</div>`);
      joinLink({ location: body.slice(0, 500), notes: text });
      clipNotes(text);
      eventBodyText(body, "text");
      const took = performance.now() - started;
      assert.ok(took < 200, `${body.slice(0, 20)} took ${Math.round(took)} ms`);
    }
    const huge = eventBodyText(fill("<b>x</b> ").repeat(10));
    assert.ok((huge?.length ?? 0) <= 200_000);
  });

  it("turns HTML bodies into text and keeps link targets", () => {
    const html =
      '<html><body><p>Hi <b>all</b>,</p><p><a href="https://us02web.zoom.us/j/1?pwd=x&amp;y=2">Join Zoom Meeting</a></p>' +
      '<p><a href="https://example.com/doc">https://example.com/doc</a></p><script>alert(1)</script><a href="javascript:x()">bad</a></body></html>';
    const text = eventBodyText(html, "html")!;
    assert.match(text, /^Hi all,$/m);
    assert.match(text, /Join Zoom Meeting <https:\/\/us02web\.zoom\.us\/j\/1\?pwd=x&y=2>/);
    assert.match(text, /^https:\/\/example\.com\/doc$/m);
    assert.doesNotMatch(text, /<(?!https)|alert|javascript/);
    assert.equal(joinLink({ location: null, notes: text })?.url, "https://us02web.zoom.us/j/1?pwd=x&y=2");
    assert.equal(eventBodyText("<p><a href=https://zoom.us/j/2>J2</a></p>", "html"), "J2 <https://zoom.us/j/2>");
  });

  it("detects HTML in feed descriptions and tidies plain text", () => {
    assert.equal(eventBodyText('Join <a href="https://meet.google.com/abc-defg-hij">here</a><br>Bring notes'), "Join here <https://meet.google.com/abc-defg-hij>\nBring notes");
    assert.equal(eventBodyText("Line one  \r\n\r\n\r\n\r\nLine\u0000 two\t"), "Line one\n\nLine two");
    assert.equal(eventBodyText("   \n  "), null);
    assert.equal(eventBodyText("Join <https://zoom.us/j/1>\nbye"), "Join <https://zoom.us/j/1>\nbye");
    assert.equal(eventBodyText("if x <p and y > 3 then"), "if x <p and y > 3 then");
    assert.equal(eventBodyText("Join <https://zoom.us/j/1><br>bye"), "Join <https://zoom.us/j/1>\nbye");
    assert.equal(eventBodyText("Open https://good.example/\u202egnp.exe now"), "Open https://good.example/gnp.exe now");
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
    const location = renderToStaticMarkup(createElement(LinkedText, { text: "Room \u202e4 https://good.example/\u202egnp.exe" }));
    assert.doesNotMatch(location, /\u202e/);
    assert.doesNotMatch(markup, /<script|<b>/);
  });

  it("clamps the description until it is opened", () => {
    const markup = renderToStaticMarkup(createElement(EventNotes, { id: "e1", text: `Agenda\n${"Line\n".repeat(40)}https://zoom.us/j/1` }));
    assert.match(markup, /Description/);
    assert.match(markup, /id="event-notes-e1" class="[^"]*line-clamp-\[8\][^"]*whitespace-pre-line|id="event-notes-e1" class="[^"]*whitespace-pre-line[^"]*line-clamp-\[8\]/);
    assert.match(markup, /href="https:\/\/zoom\.us\/j\/1"/);
  });
});
