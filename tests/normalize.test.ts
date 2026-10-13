import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalDomain,
  canonicalLinkedin,
  normalizeCompanyName,
  normalizeCompanyWrite,
  normalizePersonName,
} from "@/lib/crm/normalize";

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
    assert.equal(normalizeCompanyName("Café Müller GmbH"), "cafe muller");
  });

  it("keeps non-Latin names and symbols that tell companies apart", () => {
    assert.equal(normalizeCompanyName("株式会社メルカリ"), "株式会社メルカリ");
    assert.equal(normalizeCompanyName("Яндекс"), "яндекс");
    assert.equal(normalizeCompanyName("Straße AG"), "straße ag");
    assert.notEqual(normalizeCompanyName("C++ Corp"), normalizeCompanyName("C# Inc"));
    assert.equal(normalizePersonName("José Müller"), "jose muller");
    assert.equal(normalizePersonName("李 小龍"), "李 小龍");
    assert.equal(normalizePersonName("Ελένη"), "ελενη");
  });

  it("does not take a domain from a shared website host", () => {
    const linkedin = normalizeCompanyWrite(
      { name: "Foo", website: "https://www.linkedin.com/company/foo" },
      "upsert",
    );
    assert.equal(linkedin.domain, undefined);
    assert.equal(linkedin.website, "https://linkedin.com/company/foo");
    const own = normalizeCompanyWrite({ name: "Foo", website: "https://foo.io/about" }, "create");
    assert.equal(own.domain, "foo.io");
  });
});

describe("contact identity", () => {
  it("accepts regional LinkedIn hosts and rejects malformed escapes", () => {
    assert.equal(
      canonicalLinkedin("https://uk.linkedin.com/in/Jane-Doe/"),
      "https://www.linkedin.com/in/jane-doe",
    );
    assert.equal(canonicalLinkedin("linkedin.com/in/%E0%A4%A"), null);
    assert.equal(canonicalLinkedin("https://notlinkedin.com/in/jane"), null);
  });
});
