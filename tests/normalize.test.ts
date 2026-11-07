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

  it("accepts accented profile slugs, encoded or not, as one canonical URL", () => {
    const canonical = "https://www.linkedin.com/in/josé-garcía-0a1b2c";
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-0a1b2c/"), canonical);
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/JOS%C3%89-GARC%C3%8DA-0a1b2c"), canonical);
    assert.equal(canonicalLinkedin("linkedin.com/in/josé-garcía-0a1b2c"), canonical);
    assert.equal(canonicalLinkedin("https://de.linkedin.com/in/JOSÉ-GARCÍA-0a1b2c?trk=x"), canonical);
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/josé-garcía-0a1b2c"), canonical);
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/%E5%BC%A0%E4%BC%9F"), "https://www.linkedin.com/in/张伟");
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/jos%C3%A9%20garcia"), null);
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/jos%C3%A9.garcia"), null);
    assert.equal(canonicalLinkedin("https://www.linkedin.com/in/%E2%9C%93%E2%9C%93"), null);
  });
});
