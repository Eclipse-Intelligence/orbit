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

  it("removes every meta element, however it is written", () => {
    const hostile = [
      '<meta http-equiv="refresh" content="0;url=https://evil.test">',
      '<meta content="5;url=https://evil.test/?a>b" http-equiv="refresh">',
      "<meta content='5;url=https://evil.test/?a>b' http-equiv='refresh'>",
      '<meta http-equiv="&#114;efresh" content="0;url=https://evil.test">',
      '<meta http-equiv="&#x72;efresh" content="0;url=https://evil.test">',
      '<META HTTP-EQUIV=REFRESH CONTENT="0;url=https://evil.test">',
      '<meta\nhttp-equiv\n=\n"refresh"\ncontent="0;url=https://evil.test">',
      '<meta/http-equiv="refresh"/content="0;url=https://evil.test"/>',
      '<meta http-equiv="refresh" content="0;url=https://evil.test"',
      '<meta http-equiv="refresh content="0;url=https://evil.test">',
      '<meta name="orbit-frame" content="abc">',
      "</meta>",
    ];
    for (const tag of hostile) {
      const cleaned = cleanEmailHtml(`<p>before</p>${tag}<p>after</p>`);
      assert.equal(/<\/?meta/i.test(cleaned), false, tag);
      assert.equal(/refresh/i.test(cleaned.replace(/<[^>]*>/g, "")), false, tag);
      assert.ok(cleaned.startsWith("<p>before</p>"), tag);
    }
    assert.equal(cleanEmailHtml('<p>a</p><meta http-equiv="refresh" content="0;url=https://evil.test"><p>b</p>'), "<p>a</p><p>b</p>");
  });

  it("leaves no other way for an email to navigate the frame", () => {
    const hostile = [
      '<base href="https://evil.test/">',
      '<base target="_top" href="a>b">',
      '<form action="https://evil.test"><input type="submit"></form>',
      '<frameset><frame src="https://evil.test"></frameset>',
      '<object data="https://evil.test"></object>',
      '<embed src="https://evil.test">',
      '<iframe src="https://evil.test"></iframe>',
      '<link rel="prefetch" href="https://evil.test">',
      '<svg><set attributeName="href" to="https://evil.test"/><a href="x">y</a></svg>',
      '<svg><animate attributeName="href" values="https://evil.test"/></svg>',
    ];
    for (const tag of hostile) {
      const cleaned = cleanEmailHtml(`<p>before</p>${tag}<p>after</p>`);
      assert.equal(/<\/?(base|form|frameset|frame|object|embed|iframe|link|set|animate)\b/i.test(cleaned), false, tag);
      assert.equal(cleaned.includes("evil.test"), false, tag);
    }
  });

  it("drops script and data addresses however they are spelled", () => {
    const hostile = [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="  JavaScript:alert(1)">x</a>',
      '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href="&#106;avascript&colon;alert(1)">x</a>',
      '<a href="java&Tab;script:alert(1)">x</a>',
      "<a href='java\nscript:alert(1)'>x</a>",
      "<a href=javascript:alert(1)>x</a>",
      '<a href="vbscript:x">x</a>',
      '<a href="data:text/html,<p>x</p>">x</a>',
      '<svg><a xlink:href="javascript:alert(1)" target="_self">x</a></svg>',
      '<button formaction="javascript:alert(1)">x</button>',
    ];
    for (const tag of hostile) {
      const cleaned = cleanEmailHtml(tag);
      assert.equal(/script:|data:text/i.test(cleaned.replace(/&[^;]+;/g, "")), false, tag);
      assert.equal(/href\s*=|formaction/i.test(cleaned), false, tag);
    }
    assert.equal(cleanEmailHtml('<a href="https://x.test/?next=javascript:1">x</a>'), '<a href="https://x.test/?next=javascript:1" target="_blank">x</a>');
  });

  it("forces every link, including one inside an svg, to open in a new tab", () => {
    assert.equal(cleanEmailHtml('<svg><a href="https://x.test" target="_self"><text>x</text></a></svg>'), '<svg><a href="https://x.test" target="_blank"><text>x</text></a></svg>');
  });

  it("cannot be tricked into rebuilding a tag by removing another", () => {
    const refresh = 'http-equiv="refresh" content="0;url=https://evil.example/"';
    const hostile = [
      `<me<meta>ta ${refresh}>`,
      `<me src="javascript:x"ta http-equiv=refresh content="0;url=https://evil.example/">`,
      `<m<meta><meta>eta ${refresh}>`,
      `<<meta>meta ${refresh}>`,
      `<scr<script>x</script>ipt>alert(1)</script>`,
      `<ifr<iframe></iframe>ame src="https://evil.example/"></iframe>`,
      `<ba<base href="https://a.test/">se href="https://evil.example/">`,
      `<fo<form></form>rm action="https://evil.example/"></form>`,
      `<img sr<img src="https://x.test/api/mail/open/0e9b1b8a-6a6c-4b7a-9d43-5d2f1a2b3c4d">c="https://x.test/api/mail/open/0e9b1b8a-6a6c-4b7a-9d43-5d2f1a2b3c4d">`,
      `<a hr<a href="javascript:x">ef="javascript:x">x</a>`,
      `<img sr<img src="cid:a">c="cid:a">`,
      `<me<me<meta>ta>ta ${refresh}>`,
    ];
    for (const attack of hostile) {
      const cleaned = cleanEmailHtml(`<p>a</p>${attack}<p>b</p>`);
      const tags = [...cleaned.matchAll(/<[^>]*>/g)].map((match) => match[0]).join("");
      assert.equal(/<\/?(meta|script|iframe|base|form)\b/i.test(cleaned), false, attack);
      assert.equal(/refresh|javascript:|\/api\/mail\/open\/|cid:|evil\.example/i.test(tags), false, attack);
      assert.equal(cleanEmailHtml(cleaned), cleaned, attack);
    }
  });

  it("gives up safely on input that keeps rebuilding itself", () => {
    const depth = 40;
    const attack = `${"<me".repeat(depth)}${"<meta>".repeat(1)}${"ta>".repeat(depth)} http-equiv="refresh" content="0;url=https://evil.example/">`;
    const cleaned = cleanEmailHtml(attack);
    assert.equal(/<meta/i.test(cleaned), false);
    assert.equal(/<[a-z]/i.test(cleaned), false);
    assert.equal(cleanEmailHtml("<p>Plain <strong>mail</strong></p>"), "<p>Plain <strong>mail</strong></p>");
  });
});
