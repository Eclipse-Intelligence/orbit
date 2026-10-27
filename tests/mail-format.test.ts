import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { afterSending, snippetCore } from "@/lib/mail/format";

describe("mail previews", () => {
  it("drops the quoted history from a preview", () => {
    assert.equal(snippetCore("Ok boo x ________________________________ From: charlotte ridgeon Sent: Saturday"), "Ok boo x");
    assert.equal(snippetCore("i am flagging now though On Sat, Oct 24, 2026 at 12:06 PM Mark Ridgeon <mark@ridgeon.me> wrote: Ok boo x"), "i am flagging now though");
    assert.equal(snippetCore("Thanks ----- Original Message ----- From: Jane"), "Thanks");
  });

  it("keeps previews that have no quoted history", () => {
    assert.equal(snippetCore("On Monday we kick off the pilot. Who wrote the brief?"), "On Monday we kick off the pilot. Who wrote the brief?");
    assert.equal(snippetCore("From the board: approved."), "From the board: approved.");
    assert.equal(snippetCore(null), "");
  });

  it("says how long after sending an email was opened", () => {
    const sent = "2026-10-27T21:14:51.000Z";
    assert.equal(afterSending("2026-10-27T21:15:11.000Z", sent), "20 seconds after sending");
    assert.equal(afterSending("2026-10-27T21:14:52.000Z", sent), "1 second after sending");
    assert.equal(afterSending("2026-10-27T21:19:51.000Z", sent), "5 minutes after sending");
    assert.equal(afterSending("2026-10-27T22:14:50.000Z", sent), "59 minutes after sending");
    assert.equal(afterSending("2026-10-28T00:20:00.000Z", sent), "3 hours after sending");
    assert.equal(afterSending("2026-10-29T21:14:51.000Z", sent), "2 days after sending");
    assert.equal(afterSending("2026-10-27T21:14:50.000Z", sent), "0 seconds after sending");
    assert.equal(afterSending("2026-10-27T21:15:11.000Z", null), null);
  });
});
