import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanEmailHtml, openLinksInNewTab } from "@/lib/mail/html";

describe("email links", () => {
  it("opens every link in a new tab whatever target it asked for", () => {
    assert.equal(openLinksInNewTab('<a href="https://x.test" target="_self">x</a>'), '<a href="https://x.test" target="_blank">x</a>');
    assert.equal(openLinksInNewTab("<A HREF='https://x.test' TARGET='_top'>x</A>"), '<A HREF=\'https://x.test\' target="_blank">x</A>');
    assert.equal(openLinksInNewTab("<a target=_parent href=https://x.test>x</a>"), '<a href=https://x.test target="_blank">x</a>');
    assert.equal(openLinksInNewTab('<area shape="rect" target="_self" href="https://x.test">'), '<area shape="rect" href="https://x.test" target="_blank">');
    assert.equal(openLinksInNewTab("<a>x</a>"), '<a target="_blank">x</a>');
  });

  it("keeps a target-like word inside another value and a greater-than inside a quote", () => {
    assert.equal(openLinksInNewTab('<a href="https://x.test/?a=1 target=2" title="a > b">x</a>'), '<a href="https://x.test/?a=1 target=2" title="a > b" target="_blank">x</a>');
  });

  it("leaves other tags alone", () => {
    assert.equal(openLinksInNewTab('<abbr title="x">y</abbr><p target="_self">z</p>'), '<abbr title="x">y</abbr><p target="_self">z</p>');
  });

  it("rewrites targets as part of cleaning an email", () => {
    assert.equal(cleanEmailHtml('<a href="https://x.test" target="_self" onclick="x()">Go</a>'), '<a href="https://x.test" target="_blank">Go</a>');
  });
});
