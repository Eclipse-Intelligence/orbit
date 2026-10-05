import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalDomain, normalizeCompanyName } from "@/lib/crm/normalize";

describe("company identity", () => {
  it("canonicalises domains and strips a leading www", () => {
    assert.equal(canonicalDomain("HTTPS://WWW.Example.com/about"), "example.com");
    assert.equal(canonicalDomain("example.com"), "example.com");
    assert.equal(canonicalDomain("not a domain"), null);
  });

  it("normalises company names and legal suffixes", () => {
    assert.equal(normalizeCompanyName("  Acme, Inc. "), "acme");
    assert.equal(normalizeCompanyName("Smith & Co."), "smith and");
    assert.equal(normalizeCompanyName("LVMH"), "lvmh");
  });
});
