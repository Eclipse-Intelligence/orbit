import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookingUrl, linksSection } from "@/lib/assistant/links";
import { systemPrompt } from "@/lib/assistant/prompt";
import type { UserActor } from "@/lib/crm/types";

const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark Ridgeon", role: "owner", scopes: [] } as unknown as UserActor;

describe("the user's links in the assistant", () => {
  it("gives the full booking page address and the meeting room", () => {
    const previous = process.env.SITE_URL;
    process.env.SITE_URL = "https://orbit.geteclipse.co";
    try {
      assert.equal(bookingUrl("mark"), "https://orbit.geteclipse.co/book/mark");
      const links = { booking: { url: bookingUrl("mark"), enabled: true, title: "Book a call with Mark", durationMinutes: 30 }, meetingLink: "https://geteclipse.whereby.com/room" };
      const prompt = systemPrompt(actor, { webSearch: false, links });
      assert.match(prompt, /Booking page, where people pick a time with the user: https:\/\/orbit\.geteclipse\.co\/book\/mark \("Book a call with Mark", 30 minutes\)\./);
      assert.match(prompt, /Video meeting link for calls: https:\/\/geteclipse\.whereby\.com\/room\. This is a meeting room, not the booking page\./);
      assert.match(prompt, /exactly as written above/);
      assert.match(linksSection({ ...links, booking: { ...links.booking, enabled: false } }), /currently switched off/);
      assert.match(linksSection({ booking: null, meetingLink: null }), /No booking page yet/);
      assert.ok(!systemPrompt(actor, { webSearch: false }).includes("# The user's links"));
    } finally {
      if (previous === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = previous;
    }
  });
});
