import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorBudget, resolveAnchor, type CommentAnchor } from "@/lib/docs/comment-anchor";
import { placeThreads } from "@/lib/docs/comment-layout";
import { commentViews, type DocComment } from "@/lib/docs/comments";

const SECOND = 1000;

function comment(index: number, anchor: CommentAnchor, resolved = false): DocComment {
  return {
    id: `root-${index}`,
    parentId: null,
    authorName: "Rae Reader",
    authorKind: "visitor",
    authorUserId: null,
    body: `Comment ${index}`,
    anchor,
    createdAt: "2026-11-26T10:00:00.000Z",
    editedAt: null,
    resolved,
  };
}

function took<T>(work: () => T) {
  const started = Date.now();
  const result = work();
  return { result, ms: Date.now() - started };
}

const PROSE = "We will receive the parcel on Friday and then check every box. ".repeat(16_000);

function missing(index: number): CommentAnchor {
  const quote = `${index} nothing like this sentence appears anywhere in the document `.repeat(6).slice(0, 400);
  return { quote, prefix: "Text that was here before", suffix: "text that followed it", at: 400_000 };
}

describe("Reading comments has a work budget for the whole doc", () => {
  it("reads 1000 comments whose text is gone from a 1MB doc in a few seconds", () => {
    const comments = Array.from({ length: 1000 }, (_, index) => comment(index, missing(index)));
    const { result, ms } = took(() => commentViews(comments, PROSE));
    assert.ok(ms < 3 * SECOND, `took ${ms}ms`);
    assert.equal(result.length, 1000);
    assert.ok(result.every((view) => view.orphaned));
  });

  it("reads 1000 comments with a short repeated prefix and no matching suffix quickly", () => {
    const text = "a".repeat(1_000_000);
    const comments = Array.from({ length: 1000 }, (_, index) => comment(index, { quote: `b${index}`.padEnd(40, "c"), prefix: "a".repeat(32), suffix: "z".repeat(32), at: 10 }));
    const { ms } = took(() => commentViews(comments, text));
    assert.ok(ms < 3 * SECOND, `took ${ms}ms`);
  });

  it("reads 1000 comments on a one character quote that matches everywhere quickly", () => {
    const text = "a".repeat(1_000_000);
    const comments = Array.from({ length: 1000 }, (_, index) => comment(index, { quote: "a", prefix: "a".repeat(32), suffix: "a".repeat(32), at: index }));
    const { ms } = took(() => commentViews(comments, text));
    assert.ok(ms < 3 * SECOND, `took ${ms}ms`);
  });

  it("places 1000 threads for the browser quickly too", () => {
    const threads = Array.from({ length: 1000 }, (_, index) => ({ id: `root-${index}`, anchor: missing(index), resolved: false }));
    const { result, ms } = took(() => placeThreads(PROSE, threads));
    assert.ok(ms < 3 * SECOND, `took ${ms}ms`);
    assert.equal(result.placed.length + result.orphaned.length, 1000);
  });

  it("orphans what is left once the shared budget is spent, and nothing before", () => {
    const text = "The quick brown fox jumps over the lazy dog near the river bank.";
    const anchor: CommentAnchor = { quote: "quick brown fox", prefix: "The ", suffix: " jumps over", at: 4 };
    const budget = anchorBudget();
    assert.equal(resolveAnchor(text, anchor, { budget }).status, "found");
    budget.left = 0;
    assert.equal(resolveAnchor(text, anchor, { budget }).status, "orphaned");
  });

  it("does not fuzzy match resolved threads, and still finds open ones that moved a little", () => {
    const text = "Before. The delivery was going to arrive on Friday morning for sure. After.";
    const edited: CommentAnchor = { quote: "The delivery was going to arrive on Thursday morning", prefix: "", suffix: "", at: 8 };
    const open = commentViews([comment(1, edited)], text)[0];
    const resolved = commentViews([comment(2, edited, true)], text)[0];
    assert.equal(open.orphaned, false);
    assert.equal(resolved.orphaned, true);
    const layout = placeThreads(text, [
      { id: "open", anchor: edited, resolved: false },
      { id: "resolved", anchor: edited, resolved: true },
    ]);
    assert.deepEqual(layout.placed.map((item) => item.id), ["open"]);
    assert.deepEqual(layout.orphaned, ["resolved"]);
  });

  it("still places many ordinary comments on a normal doc", () => {
    const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} says that the parcel arrives on day ${index}.`).join("\n\n");
    const threads = Array.from({ length: 200 }, (_, index) => {
      const quote = `parcel arrives on day ${index}`;
      const at = text.indexOf(quote);
      return { id: `root-${index}`, resolved: false, anchor: { quote, prefix: text.slice(Math.max(0, at - 20), at), suffix: text.slice(at + quote.length, at + quote.length + 8), at } };
    });
    const layout = placeThreads(text, threads);
    assert.equal(layout.placed.length, 200);
    assert.equal(layout.orphaned.length, 0);
  });

  describe("resolved threads never starve open ones", () => {
    const text = Array.from({ length: 800 }, (_, index) => `Paragraph ${index} explains that the delivery of the parcel is expected on day ${index % 28}.`).join("\n\n");

    function resolvedFirst(count: number) {
      return Array.from({ length: count }, (_, index) => ({ id: `done-${index}`, anchor: { quote: "e", prefix: "", suffix: "", at: index }, resolved: true }));
    }

    function edited(count: number) {
      return Array.from({ length: count }, (_, index) => {
        const quote = `Paragraph ${index * 7} explains that the delivary of the parcel is expected`;
        const at = text.indexOf(`Paragraph ${index * 7} explains`);
        return { id: `open-${index}`, anchor: { quote, prefix: "", suffix: "", at }, resolved: false };
      });
    }

    it("places lightly edited open threads however many resolved ones come before them", () => {
      const threads = [...resolvedFirst(600), ...edited(8)];
      const layout = placeThreads(text, threads);
      assert.deepEqual(
        layout.placed.filter((item) => item.id.startsWith("open-")).map((item) => item.id),
        edited(8).map((thread) => thread.id),
      );
    });

    it("keeps the result in the order the threads came in", () => {
      const threads = [...resolvedFirst(3), ...edited(3)];
      const layout = placeThreads(text, threads);
      assert.deepEqual(layout.placed.map((item) => item.id), ["done-0", "done-1", "done-2", "open-0", "open-1", "open-2"].filter((id) => layout.placed.some((item) => item.id === id)));
      assert.deepEqual(layout.placed.map((item) => item.id), threads.map((thread) => thread.id).filter((id) => !layout.orphaned.includes(id)));
    });

    it("reads comments for REST, MCP and the assistant the same way", () => {
      const open = edited(8).map((thread, index) => comment(index, thread.anchor));
      const done = resolvedFirst(600).map((thread, index) => comment(1000 + index, thread.anchor, true));
      const views = commentViews([...done, ...open], text);
      assert.deepEqual(
        views.filter((view) => view.status === "open").map((view) => view.orphaned),
        new Array(8).fill(false),
      );
    });
  });
});
