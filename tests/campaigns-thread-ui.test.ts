import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignRowMeta,
  campaignStateLine,
  contactLineText,
  failedSendPlan,
  messageStatus,
  newClientKey,
  mailboxParts,
  noteLabel,
  replyChannel,
  restoredDraft,
  retryable,
  sourceLink,
  timelineEntries,
  unsettled,
  withoutReply,
  withPending,
  type PendingReply,
} from "@/lib/campaigns/thread-view";
import type { CampaignLine, CampaignTimelineRow, ReplyOption, ThreadCampaign, ThreadItem, ThreadMessage, ThreadNote } from "@/lib/campaigns/threads";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ZONE = "Europe/London";

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    type: "message",
    id: "m1",
    prospectId: "p1",
    campaignId: "c1",
    campaignName: "Agency outreach",
    channel: "email",
    direction: "outbound",
    subject: null,
    body: "Hi Priya",
    at: "2026-11-12T09:00:00.000Z",
    author: "Mark Ridgeon",
    address: null,
    sentByUserId: "u1",
    sendState: null,
    sendError: null,
    clientKey: null,
    automatic: false,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingReply> = {}): PendingReply {
  return { clientKey: "web-1", prospectId: "p1", channel: "email", text: "Tuesday?", at: "2026-11-17T11:59:00.000Z", state: "sending", messageId: null, error: null, ...overrides };
}

function option(channel: ReplyOption["channel"], canReply: boolean): ReplyOption {
  return { channel, prospectId: `p-${channel}`, campaignName: channel, canReply, reason: canReply ? null : "Only Mark Ridgeon can reply from this LinkedIn account.", senderName: null };
}

describe("optimistic replies", () => {
  it("shows a reply straight away and hides it once the server has it, by key or by id", () => {
    const items: ThreadItem[] = [message()];
    const shown = withPending(items, [pending()]);
    assert.equal(shown.length, 2);
    assert.equal(shown[1].type, "pending");
    assert.equal(withPending([...items, message({ id: "m2", clientKey: "web-1" })], [pending()]).length, 2);
    assert.equal(withPending([...items, message({ id: "m2" })], [pending({ messageId: "m2" })]).length, 2);
    assert.deepEqual(unsettled([...items, message({ id: "m2", clientKey: "web-1" })], [pending(), pending({ clientKey: "web-2" })]).map((reply) => reply.clientKey), ["web-2"]);
  });

  it("puts unsaved failed text back only into an empty composer, and keeps a stored failure as a bubble", () => {
    assert.equal(failedSendPlan("", false), "restore");
    assert.equal(failedSendPlan("   ", false), "restore");
    assert.equal(failedSendPlan("New words", false), "keep");
    assert.equal(failedSendPlan("", true), "keep");
    assert.equal(failedSendPlan("", undefined), "keep");
    assert.deepEqual(withoutReply([pending(), pending({ clientKey: "web-9" })], "web-9").map((reply) => reply.clientKey), ["web-1"]);
  });

  it("restores the channel together with the text, and leaves new typing and its channel alone", () => {
    const failed = { text: "Does Tuesday work?", channel: "linkedin" as const };
    assert.deepEqual(restoredDraft({ text: "", chosen: "email" }, failed), { text: "Does Tuesday work?", chosen: "linkedin" });
    assert.deepEqual(restoredDraft({ text: "Something new", chosen: "email" }, failed), { text: "Something new", chosen: "email" });
    assert.deepEqual(restoredDraft({ text: "Something new", chosen: null }, failed), { text: "Something new", chosen: null });
  });

  it("keeps the same items when nothing is waiting", () => {
    const items: ThreadItem[] = [message()];
    assert.equal(withPending(items, []), items);
  });

  it("makes keys the engine accepts, and a new one each time", () => {
    const first = newClientKey();
    assert.match(first, /^[A-Za-z0-9_:.-]{1,200}$/);
    assert.notEqual(first, newClientKey());
    assert.match(newClientKey(() => "bad key/with spaces"), /^[A-Za-z0-9_:.-]{1,200}$/);
  });

  it("offers Try again only on the sender's own failed reply", () => {
    assert.equal(retryable(message({ sendState: "failed", clientKey: "web-1" })), true);
    assert.equal(retryable(message({ sendState: "failed", clientKey: null })), false);
    assert.equal(retryable(message({ sendState: "unknown", clientKey: "web-1" })), false);
    assert.equal(retryable(message({ direction: "inbound", sendState: "failed", clientKey: "web-1" })), false);
  });

  it("says how a message stands", () => {
    assert.equal(messageStatus(message()), null);
    assert.equal(messageStatus(message({ sendState: "sending" })), "Sending…");
    assert.equal(messageStatus(message({ sendState: "failed" })), "Couldn't send.");
    assert.equal(messageStatus(message({ sendState: "unknown" })), "May not have gone.");
    assert.equal(messageStatus(message({ direction: "inbound", automatic: true })), "Automatic reply");
  });
});

describe("the reply channel", () => {
  it("starts on the channel they last wrote on when the viewer can reply there", () => {
    assert.equal(replyChannel([option("email", true), option("linkedin", true)], "linkedin"), "linkedin");
  });

  it("moves to a channel the viewer can use, but keeps a channel they picked", () => {
    const options = [option("email", true), option("linkedin", false)];
    assert.equal(replyChannel(options, "linkedin"), "email");
    assert.equal(replyChannel(options, "linkedin", "linkedin"), "linkedin");
  });

  it("shows the only channel even when the viewer can't use it, so the reason shows", () => {
    assert.equal(replyChannel([option("linkedin", false)], "email"), "linkedin");
    assert.equal(replyChannel([], "email"), null);
  });
});

describe("lines and notes", () => {
  it("dates an acceptance and leaves other notes as they are", () => {
    const note: ThreadNote = { type: "note", id: "n1", kind: "accepted", text: "Accepted", prospectId: "p1", campaignId: "c1", campaignName: "Agency founders", channel: "linkedin", at: "2026-11-14T10:00:00.000Z" };
    assert.equal(noteLabel(note, ZONE, NOW), "Accepted 14 Nov");
    assert.equal(noteLabel({ ...note, at: "2025-11-14T10:00:00.000Z" }, ZONE, NOW), "Accepted 14 Nov 2025");
    assert.equal(noteLabel({ ...note, kind: "stopped", text: "Stopped in Agency outreach" }, ZONE, NOW), "Stopped in Agency outreach");
  });

  it("writes each campaign's state for the side panel", () => {
    const campaign: ThreadCampaign = { prospectId: "p1", campaignId: "c1", name: "Agency founders", channel: "linkedin", provider: "heyreach", state: "replied", skipReason: null, category: null, sender: null, canPause: false, canResume: false, canRemove: true };
    assert.equal(campaignStateLine(campaign), "Agency founders · replied");
    assert.equal(campaignStateLine({ ...campaign, state: "skipped", skipReason: "Skipped: open opportunity" }), "Agency founders · skipped: open opportunity");
    assert.equal(campaignStateLine({ ...campaign, state: "failed", skipReason: null }), "Agency founders · failed");
  });

  it("dates the contact page's lines only where a date reads naturally", () => {
    const line: CampaignLine = { prospectId: "p1", campaignId: "c1", campaignName: "Agency founders", channel: "linkedin", label: "Accepted", at: "2026-11-12T16:40:00.000Z" };
    assert.equal(contactLineText(line, ZONE, NOW), "Accepted 12 Nov · Agency founders");
    assert.equal(contactLineText({ ...line, label: "Step 2 sent", campaignName: "Agency outreach" }, ZONE, NOW), "Step 2 sent · Agency outreach");
    assert.equal(contactLineText({ ...line, at: null }, ZONE, NOW), "Accepted · Agency founders");
  });

  it("links a variable's source only when it is a web address", () => {
    assert.deepEqual(sourceLink("https://www.halcyon.digital/news/"), { label: "halcyon.digital/news", href: "https://www.halcyon.digital/news/" });
    assert.deepEqual(sourceLink("Proof list"), { label: "Proof list", href: null });
    assert.deepEqual(sourceLink("javascript:alert(1)"), { label: "javascript:alert(1)", href: null });
    assert.equal(sourceLink("  "), null);
    assert.equal(sourceLink(null), null);
  });
});

describe("the contact timeline", () => {
  it("puts campaign rows beside activities with their campaign and sender", () => {
    const row: CampaignTimelineRow = { id: "e1", kind: "invite_accepted", title: "Invite accepted", at: "2026-11-12T16:40:00.000Z", prospectId: "p1", campaignId: "c1", campaignName: "Agency founders", channel: "linkedin", detail: "Mark Ridgeon" };
    const entries = timelineEntries([{ id: "a1", occurredAt: "2026-11-10T07:04:00.000Z" }], [row]);
    assert.deepEqual(entries.map((entry) => [entry.type, entry.id, entry.occurredAt]), [
      ["activity", "a1", "2026-11-10T07:04:00.000Z"],
      ["campaign", "campaign:e1", "2026-11-12T16:40:00.000Z"],
    ]);
    assert.equal(campaignRowMeta(row), "Agency founders · Mark Ridgeon");
    assert.equal(campaignRowMeta({ ...row, detail: null }), "Agency founders");
  });
});

describe("the sending mailbox", () => {
  it("splits a From display name from its address and keeps a bare address as it is", () => {
    assert.deepEqual(mailboxParts("Mark Ridgeon <mark@ridgeon-mail.test>"), { name: "Mark Ridgeon", address: "mark@ridgeon-mail.test" });
    assert.deepEqual(mailboxParts('"Ridgeon, Mark" <mark@ridgeon-mail.test> '), { name: "Ridgeon, Mark", address: "mark@ridgeon-mail.test" });
    assert.deepEqual(mailboxParts("<mark@ridgeon-mail.test>"), { name: null, address: "mark@ridgeon-mail.test" });
    assert.deepEqual(mailboxParts("mark@ridgeon-mail.test <mark@ridgeon-mail.test>"), { name: null, address: "mark@ridgeon-mail.test" });
    assert.deepEqual(mailboxParts("mark@ridgeon-mail.test"), { name: null, address: "mark@ridgeon-mail.test" });
    assert.equal(mailboxParts("  "), null);
    assert.equal(mailboxParts(null), null);
  });
});
