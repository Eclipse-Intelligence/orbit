import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentDisposition, wantsDownload } from "@/lib/content-disposition";

describe("content disposition", () => {
  it("names a download with its real file name", () => {
    assert.equal(contentDisposition("attachment", "Proposal.pdf"), `attachment; filename="Proposal.pdf"; filename*=UTF-8''Proposal.pdf`);
  });

  it("keeps inline files inline", () => {
    assert.equal(contentDisposition("inline", "logo.png"), `inline; filename="logo.png"; filename*=UTF-8''logo.png`);
  });

  it("encodes names outside ASCII and the characters RFC 5987 reserves", () => {
    const header = contentDisposition("attachment", "Café (draft) it's 100%*.pdf");
    assert.equal(header, `attachment; filename="Caf_ (draft) it's 100%*.pdf"; filename*=UTF-8''Caf%C3%A9%20%28draft%29%20it%27s%20100%25%2A.pdf`);
    const encoded = header.split("filename*=UTF-8''")[1];
    assert.equal(decodeURIComponent(encoded), "Café (draft) it's 100%*.pdf");
  });

  it("strips characters that could break the header", () => {
    const header = contentDisposition("attachment", 'bad"\r\nname\\.pdf');
    assert.doesNotMatch(header, /[\r\n]/);
    assert.match(header, /^attachment; filename="bad___name_\.pdf"; /);
  });

  it("falls back to a name when there isn't one", () => {
    assert.match(contentDisposition("attachment", "  "), /filename="attachment"/);
  });

  it("downloads only when asked", () => {
    assert.equal(wantsDownload(new URLSearchParams("message=m&id=a&download=1")), true);
    assert.equal(wantsDownload(new URLSearchParams("message=m&id=a")), false);
    assert.equal(wantsDownload(new URLSearchParams("download=true")), false);
  });
});
