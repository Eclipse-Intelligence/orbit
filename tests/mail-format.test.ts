import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { snippetCore } from "@/lib/mail/format";

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
});
