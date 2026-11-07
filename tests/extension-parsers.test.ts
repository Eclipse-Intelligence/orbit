import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { orbitHref } from "@/extension/src/config";
import { dueDate } from "@/extension/src/panel/state";
import { canonicalCompany, canonicalProfile, classifyUrl, domainFrom, onLinkedin, targetFromPath } from "@/extension/src/urls";
import type { PageCompany, PagePerson } from "@/lib/extension/protocol";
import type { PageThread } from "@/extension/src/parsers";

const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM ?? "/home/vercel-sandbox/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome";
const FIXTURES = "tests/fixtures/linkedin";
const LINKEDIN = "https://www.linkedin.com";

describe("LinkedIn URL classification", () => {
  it("classifies profiles, companies, leads and threads by path", () => {
    assert.deepEqual(classifyUrl("https://www.linkedin.com/in/Priya-Shah-SEO/?miniProfileUrn=abc", LINKEDIN), {
      kind: "person",
      canonical: "https://www.linkedin.com/in/priya-shah-seo",
      path: "/in/Priya-Shah-SEO",
    });
    assert.equal(classifyUrl("https://www.linkedin.com/company/northlight-seo/about/", LINKEDIN).canonical, "https://www.linkedin.com/company/northlight-seo");
    assert.equal(classifyUrl("https://www.linkedin.com/school/leeds-uni/", LINKEDIN).kind, "company");
    assert.equal(
      classifyUrl("https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4,NAME_SEARCH,aBcD?_ntb=1", LINKEDIN).canonical,
      "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4",
    );
    assert.equal(classifyUrl("https://www.linkedin.com/sales/people/ACwAAB9xK2sBr4,NAME_SEARCH", LINKEDIN).canonical, "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4");
    assert.equal(classifyUrl("https://www.linkedin.com/messaging/thread/2-MWE4ZjQ/", LINKEDIN).kind, "conversation");
    assert.equal(classifyUrl("https://www.linkedin.com/feed/", LINKEDIN).kind, "other");
    assert.equal(classifyUrl("https://www.linkedin.com/sales/lists/people", LINKEDIN).kind, "other");
    assert.equal(classifyUrl("https://uk.linkedin.com/in/hannah-okafor", LINKEDIN).kind, "person");
  });

  it("only trusts the configured host and maps a fake host onto real LinkedIn URLs", () => {
    assert.equal(classifyUrl("https://evil.example/in/priya-shah-seo", LINKEDIN).kind, "other");
    assert.equal(classifyUrl("https://notlinkedin.com/in/priya-shah-seo", LINKEDIN).kind, "other");
    assert.equal(classifyUrl("not a url", LINKEDIN).kind, "other");
    assert.equal(classifyUrl(undefined, LINKEDIN).kind, "other");
    const fake = "http://127.0.0.1:4410";
    assert.equal(classifyUrl("http://127.0.0.1:4410/in/priya-shah-seo", fake).canonical, "https://www.linkedin.com/in/priya-shah-seo");
    assert.equal(classifyUrl("https://www.linkedin.com/in/priya-shah-seo", fake).kind, "other");
    assert.equal(onLinkedin("https://www.linkedin.com/in/priya-shah-seo", fake), "http://127.0.0.1:4410/in/priya-shah-seo");
  });

  it("canonicalises links found in pages and reads domains from websites", () => {
    assert.equal(canonicalProfile("/in/hannah-okafor/", "https://www.linkedin.com/messaging/"), "https://www.linkedin.com/in/hannah-okafor");
    assert.equal(canonicalProfile("/company/acme", LINKEDIN), null);
    assert.equal(canonicalCompany("https://www.linkedin.com/company/fernhill-digital/", LINKEDIN), "https://www.linkedin.com/company/fernhill-digital");
    assert.equal(targetFromPath("/in/x").kind, "other");
    assert.equal(canonicalProfile("/in/jos%C3%A9-garc%C3%ADa/", LINKEDIN), "https://www.linkedin.com/in/josé-garcía");
    assert.equal(classifyUrl("https://www.linkedin.com/in/JOS%C3%89-GARC%C3%8DA", LINKEDIN).canonical, "https://www.linkedin.com/in/josé-garcía");
    assert.equal(onLinkedin("https://www.linkedin.com/in/josé-garcía", LINKEDIN), "https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa");
    assert.equal(domainFrom("https://www.Northlightseo.co.uk/?utm_source=linkedin"), "northlightseo.co.uk");
    assert.equal(domainFrom("kestrelcontent.com"), "kestrelcontent.com");
    assert.equal(domainFrom("https://www.linkedin.com/company/acme"), null);
    assert.equal(domainFrom(""), null);
  });

  it("ignores links to other sites and short Sales Navigator ids", () => {
    assert.equal(canonicalProfile("https://other.example/in/hannah-okafor", LINKEDIN), null);
    assert.equal(canonicalCompany("https://other.example/company/acme", "https://www.linkedin.com/in/someone"), null);
    assert.equal(canonicalProfile("https://uk.linkedin.com/in/hannah-okafor", LINKEDIN), "https://www.linkedin.com/in/hannah-okafor");
    assert.equal(canonicalProfile("/in/hannah-okafor", "http://127.0.0.1:4410/messaging/"), "https://www.linkedin.com/in/hannah-okafor");
    assert.equal(classifyUrl("https://www.linkedin.com/sales/lead/ACwA", LINKEDIN).kind, "other");
  });

  it("only opens Orbit addresses on the Orbit origin", () => {
    assert.equal(orbitHref("/open?workspace=1&to=%2Fcontacts%2F2"), "https://orbit.geteclipse.co/open?workspace=1&to=%2Fcontacts%2F2");
    assert.equal(orbitHref("https://orbit.geteclipse.co/companies/1"), "https://orbit.geteclipse.co/companies/1");
    assert.equal(orbitHref("https://other.example/page"), "https://orbit.geteclipse.co/");
    assert.equal(orbitHref("//other.example/page"), "https://orbit.geteclipse.co/");
    assert.equal(orbitHref("@other.example"), "https://orbit.geteclipse.co/@other.example");
  });

  it("shows the same due dates the server uses", () => {
    const friday = new Date(2026, 10, 6, 10, 0);
    assert.equal(dueDate("today", friday), "2026-11-06");
    assert.equal(dueDate("tomorrow", friday), "2026-11-09");
    assert.equal(dueDate("next_week", friday), "2026-11-09");
    const monday = new Date(2026, 10, 9, 10, 0);
    assert.equal(dueDate("tomorrow", monday), "2026-11-10");
    assert.equal(dueDate("next_week", monday), "2026-11-16");
    assert.equal(dueDate("2026-12-01", monday), "2026-12-01");
  });
});

describe("LinkedIn page parsers", () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;

  before(async () => {
    if (!existsSync(CHROMIUM)) throw new Error(`Chromium isn't at ${CHROMIUM}. Install it with playwright or set PLAYWRIGHT_CHROMIUM.`);
    const built = await build({
      entryPoints: ["extension/src/parsers/index.ts"],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "OrbitParsers",
      platform: "browser",
      target: "chrome116",
      logLevel: "silent",
    });
    bundle = built.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: CHROMIUM });
    page = await browser.newPage();
  });

  after(async () => {
    await browser?.close();
  });

  async function load(fixture: string) {
    await page.setContent(readFileSync(`${FIXTURES}/${fixture}`, "utf8"));
    await page.addScriptTag({ content: bundle });
  }

  async function read<T>(fixture: string, what: string, url: string): Promise<T> {
    await load(fixture);
    return page.evaluate(
      ([kind, address]) => {
        const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => Record<string, unknown> } }).OrbitParsers;
        const result = parsers.readPage(document, address, kind);
        return (result.person ?? result.company ?? result.partner ?? result.thread) as never;
      },
      [what, url] as const,
    );
  }

  it("reads the top card and current role of a profile", async () => {
    const person = await read<PagePerson>("profile-priya.html", "profile", "https://www.linkedin.com/in/priya-shah-seo/");
    assert.deepEqual(person, {
      name: "Priya Shah",
      firstName: "Priya",
      lastName: "Shah",
      headline: "Founder and CEO, Northlight SEO",
      jobTitle: "Founder and CEO",
      location: "Manchester, England, United Kingdom",
      linkedinUrl: "https://www.linkedin.com/in/priya-shah-seo",
      salesNavigatorUrl: null,
      companyName: "Northlight SEO",
      companyLinkedinUrl: "https://www.linkedin.com/company/northlight-seo",
    });
  });

  it("reads the current role from a grouped Experience entry", async () => {
    const person = await read<PagePerson>("profile-hannah.html", "profile", "http://127.0.0.1:4410/in/hannah-okafor");
    assert.equal(person.name, "Hannah Okafor");
    assert.equal(person.jobTitle, "Head of Growth");
    assert.equal(person.companyName, "Fernhill Digital");
    assert.equal(person.companyLinkedinUrl, "https://www.linkedin.com/company/fernhill-digital");
    assert.equal(person.location, "Bristol, England, United Kingdom");
    assert.equal(person.linkedinUrl, "https://www.linkedin.com/in/hannah-okafor");
  });

  it("fails soft on markup without LinkedIn's classes", async () => {
    const person = await read<PagePerson>("profile-degraded.html", "profile", "https://www.linkedin.com/in/dan-hughes-seo");
    assert.equal(person.name, "Dan Hughes");
    assert.equal(person.headline, "Head of SEO at Northlight SEO");
    assert.equal(person.jobTitle, "Head of SEO");
    assert.equal(person.companyName, "Northlight SEO");
    assert.equal(person.location, null);
    assert.equal(person.companyLinkedinUrl, null);
  });

  it("reads a profile in LinkedIn's 2026 markup without its classes", async () => {
    const person = await read<PagePerson>("profile-real-2026.html", "profile", "https://www.linkedin.com/in/alex-carter-example/");
    assert.deepEqual(person, {
      name: "Alex Carter",
      firstName: "Alex",
      lastName: "Carter",
      headline: "Fractional Revenue & Growth Leader | Helping founder-led B2B software and services firms build steady, repeatable sales | CCO at Northwind",
      jobTitle: "Chief Commercial Officer (CCO)",
      location: "Leeds Area, United Kingdom",
      linkedinUrl: "https://www.linkedin.com/in/alex-carter-example",
      salesNavigatorUrl: null,
      companyName: "NORTHWIND",
      companyLinkedinUrl: "https://www.linkedin.com/company/90000001",
    });
  });

  it("reads the name from the page title even with a notification count", async () => {
    await load("profile-real-2026.html");
    const person = await page.evaluate(() => {
      document.title = "(3) Alex Carter | LinkedIn";
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, "https://www.linkedin.com/in/alex-carter-example/", "profile").person;
    });
    assert.equal(person.name, "Alex Carter");
    assert.equal(person.headline?.endsWith("CCO at Northwind"), true);
  });

  it("takes the company of a grouped role, never its dates, when no role is current", async () => {
    await load("profile-real-2026.html");
    const person = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll("[componentkey^='entity-collection-item']"));
      entries.slice(0, 3).forEach((entry) => entry.remove());
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, "https://www.linkedin.com/in/alex-carter-example/", "profile").person;
    });
    assert.equal(person.jobTitle, "Sales & Commercial Director");
    assert.equal(person.companyName, "Contoso (UK Group)");
    assert.equal(person.companyLinkedinUrl, "https://www.linkedin.com/company/90000004");
  });

  it("falls back to the headline and top card when Experience is missing", async () => {
    await load("profile-real-2026.html");
    const person = await page.evaluate(() => {
      document.querySelector("[componentkey$='ExperienceTopLevelSection']")?.remove();
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, "https://www.linkedin.com/in/alex-carter-example/", "profile").person;
    });
    assert.equal(person.jobTitle, "CCO");
    assert.equal(person.companyName, "NORTHWIND");
    assert.equal(person.location, "Leeds Area, United Kingdom");
  });

  it("never reads date ranges, durations or employment types as a name, title or company", async () => {
    await page.setContent(`<html><head><title>LinkedIn</title></head><body><main>
      <section><h2>Jan 2016 - Sep 2024</h2><p>Oct 2024 - Present · 2 yrs 2 mos</p></section>
      <section><h2>Experience</h2>
        <div componentkey="entity-collection-item-1"><a href="/company/1/"><p>Jan 2016 - Sep 2024 · 8 yrs 9 mos</p><p>Full-time · 13 yrs 3 mos</p><p>London Area, United Kingdom · Hybrid</p></a></div>
      </section></main></body></html>`);
    await page.addScriptTag({ content: bundle });
    const person = await page.evaluate(() => {
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, "https://www.linkedin.com/in/someone", "profile").person;
    });
    assert.equal(person.name, null);
    assert.equal(person.firstName, null);
    assert.equal(person.headline, null);
    assert.equal(person.jobTitle, null);
    assert.equal(person.companyName, null);
  });

  it("reads the current role when it isn't the first Experience entry", async () => {
    await page.setContent(`<html><head><title>Jo Bloggs | LinkedIn</title></head><body><main>
      <section><h2>Jo Bloggs</h2><p>Advisor</p></section>
      <section><h2 componentkey="ProfileNullStateCardAnchor_Experience">Experience</h2>
        <div componentkey="entity-collection-item-1"><a href="/company/11/"><p>Head of Sales</p><p>Old Co · Full-time</p><p>Jan 2016 - Sep 2024 · 8 yrs 9 mos</p></a></div>
        <div componentkey="entity-collection-item-2"><a href="/company/22/"><p>New Co</p><p>Full-time · 2 yrs</p></a>
          <ul><li><a href="/company/22/"><p>Managing Director</p><p>Oct 2024 - Present · 2 yrs 2 mos</p></a></li>
          <li><a href="/company/22/"><p>Sales Director</p><p>Jan 2024 - Oct 2024 · 10 mos</p></a></li></ul></div>
      </section></main></body></html>`);
    await page.addScriptTag({ content: bundle });
    const person = await page.evaluate(() => {
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, "https://www.linkedin.com/in/jo-bloggs", "profile").person;
    });
    assert.equal(person.name, "Jo Bloggs");
    assert.equal(person.headline, "Advisor");
    assert.equal(person.jobTitle, "Managing Director");
    assert.equal(person.companyName, "New Co");
    assert.equal(person.companyLinkedinUrl, "https://www.linkedin.com/company/22");
  });

  async function readHtml(html: string, url: string) {
    await page.setContent(html);
    await page.addScriptTag({ content: bundle });
    return page.evaluate((address) => {
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => { person: PagePerson } } }).OrbitParsers;
      return parsers.readPage(document, address, "profile").person;
    }, url);
  }

  function profileHtml(name: string, top: string, experience: string) {
    return `<html><head><title>${name} | LinkedIn</title></head><body><main>
      <section><h2>${name}</h2>${top}</section>
      <section><h2>Experience</h2>${experience}</section></main></body></html>`;
  }

  const LANGUAGES = [
    {
      language: "German",
      employment: "Vollzeit",
      current: "Okt. 2024 \u2013 Heute · 2 J. 2 Mon.",
      past: "Jan. 2016 \u2013 Sept. 2024 · 8 J. 9 Mon.",
      total: "13 J. 3 Mon.",
      place: "Berlin, Deutschland · Hybrid",
    },
    {
      language: "Spanish",
      employment: "Jornada completa",
      current: "oct. 2024 - actualidad · 2 años 2 meses",
      past: "ene. 2016 - sept. 2024 · 8 años 9 meses",
      total: "13 años 3 meses",
      place: "Madrid, España · Híbrido",
    },
    {
      language: "French",
      employment: "Temps plein",
      current: "oct. 2024 - aujourd’hui · 2 ans 2 mois",
      past: "janv. 2016 - sept. 2024 · 8 ans 9 mois",
      total: "13 ans 3 mois",
      place: "Lyon, France · Hybride",
    },
  ];

  for (const words of LANGUAGES) {
    it(`reads the current role from ${words.language} flat Experience entries`, async () => {
      const person = await readHtml(
        profileHtml(
          "Jo Bloggs",
          "<p>Advisor</p>",
          `<div componentkey="entity-collection-item-1"><a href="/company/11/"><p>Head of Sales</p><p>Old Co · ${words.employment}</p><p>${words.past}</p><p>${words.place}</p></a></div>
           <div componentkey="entity-collection-item-2"><a href="/company/22/"><p>Managing Director</p><p>New Co · ${words.employment}</p><p>${words.current}</p><p>${words.place}</p></a></div>`,
        ),
        "https://www.linkedin.com/in/jo-bloggs",
      );
      assert.equal(person.jobTitle, "Managing Director");
      assert.equal(person.companyName, "New Co");
      assert.equal(person.companyLinkedinUrl, "https://www.linkedin.com/company/22");
    });

    it(`reads the current role from a ${words.language} grouped Experience entry`, async () => {
      const person = await readHtml(
        profileHtml(
          "Jo Bloggs",
          "<p>Advisor</p>",
          `<div componentkey="entity-collection-item-1"><a href="/company/22/"><p>New Co</p><p>${words.employment} · ${words.total}</p><p>${words.place}</p></a>
             <ul><li><a href="/company/22/"><p>Sales Director</p><p>${words.past}</p></a></li>
             <li><a href="/company/22/"><p>Managing Director</p><p>${words.current}</p></a></li></ul></div>`,
        ),
        "https://www.linkedin.com/in/jo-bloggs",
      );
      assert.equal(person.jobTitle, "Managing Director");
      assert.equal(person.companyName, "New Co");
      assert.equal(person.companyLinkedinUrl, "https://www.linkedin.com/company/22");
    });
  }

  it("keeps companies and titles that start with Greater or end in Area", async () => {
    const flat = await readHtml(
      profileHtml(
        "Jo Bloggs",
        "<p>Greater Manchester, England, United Kingdom</p><p>Greater London Area Manager at Greater Anglia</p><p>Greater Manchester, England, United Kingdom</p>",
        `<div componentkey="entity-collection-item-1"><a href="/company/33/"><p>Greater London Area Manager</p><p>Greater Anglia · Full-time</p><p>Oct 2024 - Present · 2 yrs</p><p>Norwich Area, United Kingdom · Hybrid</p></a></div>`,
      ),
      "https://www.linkedin.com/in/jo-bloggs",
    );
    assert.equal(flat.headline, "Greater London Area Manager at Greater Anglia");
    assert.equal(flat.jobTitle, "Greater London Area Manager");
    assert.equal(flat.companyName, "Greater Anglia");
    assert.equal(flat.location, "Greater Manchester, England, United Kingdom");

    const grouped = await readHtml(
      profileHtml(
        "Jo Bloggs",
        "<p>Inspector</p>",
        `<div componentkey="entity-collection-item-1"><a href="/company/44/"><p>Greater Manchester Police</p><p>Full-time · 12 yrs</p><p>Manchester Area, United Kingdom</p></a>
           <ul><li><a href="/company/44/"><p>Inspector</p><p>Jan 2020 - Present · 6 yrs</p></a></li></ul></div>
         <div componentkey="entity-collection-item-2"><a href="/company/55/"><p>Greater London Authority</p><p>Full-time · 3 yrs</p></a>
           <ul><li><a href="/company/55/"><p>Analyst</p><p>Jan 2016 - Dec 2019 · 4 yrs</p></a></li></ul></div>`,
      ),
      "https://www.linkedin.com/in/jo-bloggs",
    );
    assert.equal(grouped.jobTitle, "Inspector");
    assert.equal(grouped.companyName, "Greater Manchester Police");

    const headerless = await readHtml(
      profileHtml(
        "Jo Bloggs",
        "<p>Inspector</p>",
        `<div componentkey="entity-collection-item-1"><a href="/company/44/"><p>Manchester Area, United Kingdom</p><p>Full-time · 12 yrs</p></a>
           <ul><li><a href="/company/44/"><p>Inspector</p><p>Jan 2020 - Present · 6 yrs</p></a></li></ul></div>`,
      ),
      "https://www.linkedin.com/in/jo-bloggs",
    );
    assert.equal(headerless.companyName, null);
  });

  it("never takes the top card's company line as a headline or title", async () => {
    const person = await readHtml(
      `<html><head><title>Jo Bloggs | LinkedIn</title></head><body><main><section><h2>Jo Bloggs</h2>
        <p>NORTHWIND + 1 more · University of Eastbridge</p><p>Leeds Area, United Kingdom</p></section></main></body></html>`,
      "https://www.linkedin.com/in/jo-bloggs",
    );
    assert.equal(person.headline, null);
    assert.equal(person.jobTitle, null);
    assert.equal(person.companyName, "NORTHWIND");
    assert.equal(person.location, "Leeds Area, United Kingdom");
  });

  it("returns nulls instead of throwing on an empty page", async () => {
    await page.setContent("<html><body><p>Loading</p></body></html>");
    await page.addScriptTag({ content: bundle });
    const results = await page.evaluate(() => {
      const parsers = (window as unknown as { OrbitParsers: { readPage: (root: ParentNode, url: string, what: string) => unknown } }).OrbitParsers;
      return ["profile", "lead", "company", "thread"].map((what) => parsers.readPage(document, "https://www.linkedin.com/in/someone", what));
    });
    const profile = results[0] as { person: PagePerson };
    assert.equal(profile.person.name, null);
    assert.equal(profile.person.jobTitle, null);
    assert.equal(profile.person.linkedinUrl, "https://www.linkedin.com/in/someone");
    const thread = results[3] as { thread: PageThread };
    assert.deepEqual(thread.thread.messages, []);
  });

  it("reads a company page's About details", async () => {
    const company = await read<PageCompany>("company-northlight.html", "company", "https://www.linkedin.com/company/northlight-seo/about/");
    assert.deepEqual(company, {
      name: "Northlight SEO",
      tagline: "SEO and AI search visibility for B2B brands",
      website: "https://northlightseo.co.uk",
      industry: "Marketing Services",
      sizeCategory: "11-50",
      location: "Manchester, England",
      linkedinUrl: "https://www.linkedin.com/company/northlight-seo",
    });
  });

  it("falls back to the top card when a company has no About list", async () => {
    const company = await read<PageCompany>("company-kestrel.html", "company", "https://www.linkedin.com/company/kestrel-content/");
    assert.equal(company.name, "Kestrel Content Co");
    assert.equal(company.website, "https://www.kestrelcontent.com/");
    assert.equal(company.industry, "Marketing Services");
    assert.equal(company.sizeCategory, "11-50");
    assert.equal(company.location, "Cardiff, Wales");
    assert.equal(domainFrom(company.website), "kestrelcontent.com");
  });

  it("reads a Sales Navigator lead without a public profile link", async () => {
    const lead = await read<PagePerson>("sales-lead-tom.html", "lead", "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4,NAME_SEARCH,x1y2");
    assert.equal(lead.name, "Tom Reilly");
    assert.equal(lead.jobTitle, "Director");
    assert.equal(lead.companyName, "Brightline PR");
    assert.equal(lead.location, "Leeds, England, United Kingdom");
    assert.equal(lead.linkedinUrl, null);
    assert.equal(lead.salesNavigatorUrl, "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4");
  });

  it("reads only the partner from a thread unless asked for messages", async () => {
    const partner = await read<{ name: string; profileUrl: string }>("thread-priya.html", "thread-person", "https://www.linkedin.com/messaging/thread/2-MWE4ZjQ/");
    assert.deepEqual(partner, { name: "Priya Shah", profileUrl: "https://www.linkedin.com/in/priya-shah-seo" });
  });

  it("reads the messages on screen with sender, time and direction", async () => {
    await load("thread-priya.html");
    const now = new Date(2026, 10, 6, 12, 0).getTime();
    const thread = await page.evaluate((time) => {
      const parsers = (window as unknown as { OrbitParsers: { readThread: (root: ParentNode, url: string, now: Date) => unknown } }).OrbitParsers;
      return parsers.readThread(document, "https://www.linkedin.com/messaging/thread/2-MWE4ZjQ/", new Date(time));
    }, now);
    const read = thread as PageThread;
    assert.equal(read.person.name, "Priya Shah");
    assert.equal(read.messages.length, 5);
    assert.deepEqual(
      read.messages.map((message) => [message.from, message.mine, message.when]),
      [
        ["Priya Shah", false, "3 Nov, 16:42"],
        ["Mark Ridgeon", true, "3 Nov, 17:05"],
        ["Priya Shah", false, "5 Nov, 09:18"],
        ["Mark Ridgeon", true, "5 Nov, 09:31"],
        ["Priya Shah", false, "6 Nov, 08:02"],
      ],
    );
    assert.equal(read.messages[4].text, "Great. Also, could you join our team call on the 14th?");
    const first = new Date(read.messages[0].at!);
    assert.deepEqual([first.getFullYear(), first.getMonth(), first.getDate(), first.getHours(), first.getMinutes()], [2026, 10, 3, 16, 42]);
  });

  it("reads the partner and messages only from the open thread", async () => {
    const partner = await read<{ name: string | null; profileUrl: string | null }>("thread-noisy.html", "thread-person", "https://www.linkedin.com/messaging/thread/2-NOISY/");
    assert.deepEqual(partner, { name: "Sam Patel", profileUrl: null });
    const thread = await read<PageThread>("thread-noisy.html", "thread", "https://www.linkedin.com/messaging/thread/2-NOISY/");
    assert.deepEqual(
      thread.messages.map((message) => [message.from, message.mine, message.text]),
      [["Sam Patel", false, "Are you free on Thursday?"]],
    );
  });

  it("skips messages it can't tell the direction of, and never reads outside the thread", async () => {
    const thread = await read<PageThread>("thread-plain.html", "thread", "https://www.linkedin.com/messaging/thread/2-PLAIN/");
    assert.deepEqual(thread.person, { name: "Priya Shah", profileUrl: "https://www.linkedin.com/in/priya-shah-seo" });
    assert.deepEqual(
      thread.messages.map((message) => [message.from, message.mine, message.text]),
      [
        ["Priya Shah", false, "Can you send pricing?"],
        ["Priya Shah", false, "Thanks!"],
      ],
    );
  });

  it("finds no messages on a page without a thread", async () => {
    await page.setContent("<html><body><header><h2>Messaging</h2><a href='/in/mark-ridgeon/'>Me</a></header><ul><li><p>Try Premium</p></li></ul></body></html>");
    await page.addScriptTag({ content: bundle });
    const thread = await page.evaluate(() => {
      const parsers = (window as unknown as { OrbitParsers: { readThread: (root: ParentNode, url: string) => unknown } }).OrbitParsers;
      return parsers.readThread(document, "https://www.linkedin.com/messaging/thread/2-NONE/");
    });
    assert.deepEqual(thread, { person: { name: null, profileUrl: null }, messages: [] });
  });

  it("keeps the last 200 messages and caps each at 5,000 characters", async () => {
    await load("thread-priya.html");
    const thread = await page.evaluate(() => {
      const list = document.querySelector(".msg-s-message-list-content")!;
      for (let index = 0; index < 250; index += 1) {
        const item = document.createElement("li");
        const event = document.createElement("div");
        event.className = "msg-s-event-listitem msg-s-event-listitem--other";
        event.setAttribute("data-event-urn", `urn:li:msg_message:x${index}`);
        const body = document.createElement("p");
        body.className = "msg-s-event-listitem__body";
        body.textContent = index === 249 ? "x".repeat(6000) : `Message ${index}`;
        event.appendChild(body);
        item.appendChild(event);
        list.appendChild(item);
      }
      const parsers = (window as unknown as { OrbitParsers: { readThread: (root: ParentNode, url: string) => unknown } }).OrbitParsers;
      return parsers.readThread(document, "https://www.linkedin.com/messaging/thread/2-MWE4ZjQ/");
    });
    const read = thread as PageThread;
    assert.equal(read.messages.length, 200);
    assert.equal(read.messages[0].text, "Message 50");
    assert.equal(read.messages[199].text.length, 5000);
  });

  it("parses LinkedIn's day headings and times", async () => {
    await load("thread-priya.html");
    const parsed = await page.evaluate(() => {
      const parsers = (window as unknown as { OrbitParsers: { parseWhen: (day: string | null, time: string | null, now: Date) => string | null } }).OrbitParsers;
      const now = new Date(2026, 10, 6, 12, 0);
      return [
        parsers.parseWhen("Today", "4:05 PM", now),
        parsers.parseWhen("Yesterday", "09:00", now),
        parsers.parseWhen("Monday", "10:30 AM", now),
        parsers.parseWhen("Dec 30", "11:00", now),
        parsers.parseWhen("Nov 3, 2025", "11:00", now),
        parsers.parseWhen("soon", null, now),
      ].map((value) => (value ? new Date(value).toString() : null));
    });
    const parts = parsed.map((value) => (value ? new Date(value) : null));
    assert.deepEqual([parts[0]!.getDate(), parts[0]!.getHours(), parts[0]!.getMinutes()], [6, 16, 5]);
    assert.equal(parts[1]!.getDate(), 5);
    assert.deepEqual([parts[2]!.getDate(), parts[2]!.getDay()], [2, 1]);
    assert.deepEqual([parts[3]!.getFullYear(), parts[3]!.getMonth()], [2025, 11]);
    assert.equal(parts[4]!.getFullYear(), 2025);
    assert.equal(parts[5], null);
  });
});
