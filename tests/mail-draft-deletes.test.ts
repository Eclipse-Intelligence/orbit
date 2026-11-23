import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createDraftDeletes } from "@/lib/mail/draft-deletes";

function setup(problem: string | null = null) {
  const sent: { id: string; keepalive: boolean }[] = [];
  const deleted: string[] = [];
  const deletes = createDraftDeletes({
    delayMs: 8000,
    send: async (id, keepalive) => {
      sent.push({ id, keepalive });
      return problem;
    },
    deleted: (thread) => deleted.push(thread),
  });
  return { deletes, sent, deleted };
}

describe("draft discards", () => {
  it("hides a discarded draft at once and deletes it after the undo window", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes, sent, deleted } = setup();
      deletes.schedule("d1", "t1", () => undefined);
      assert.equal(deletes.isDiscarded("d1"), true);
      mock.timers.tick(7999);
      assert.equal(sent.length, 0);
      mock.timers.tick(1);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(sent, [{ id: "d1", keepalive: false }]);
      assert.deepEqual(deleted, ["t1"]);
      assert.equal(deletes.isDiscarded("d1"), true);
    } finally {
      mock.timers.reset();
    }
  });

  it("undo cancels the delete and shows the draft again", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes, sent } = setup();
      deletes.schedule("d1", "t1", () => undefined);
      assert.equal(deletes.cancel("d1"), true);
      assert.equal(deletes.isDiscarded("d1"), false);
      assert.equal(deletes.cancel("d1"), false);
      mock.timers.tick(20_000);
      assert.equal(sent.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it("discarding twice restarts the window instead of deleting early", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes, sent } = setup();
      deletes.schedule("d1", "t1", () => undefined);
      mock.timers.tick(5000);
      deletes.schedule("d1", "t1", () => undefined);
      mock.timers.tick(5000);
      assert.equal(sent.length, 0);
      assert.equal(deletes.cancel("d1"), true);
      mock.timers.tick(20_000);
      assert.equal(sent.length, 0);
      assert.equal(deletes.waiting(), 0);
    } finally {
      mock.timers.reset();
    }
  });

  it("flushes pending deletes when the page goes away", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes, sent } = setup();
      deletes.schedule("d1", "t1", () => undefined);
      deletes.schedule("d2", "t2", () => undefined);
      deletes.flush();
      assert.deepEqual(sent, [{ id: "d1", keepalive: true }, { id: "d2", keepalive: true }]);
      mock.timers.tick(20_000);
      assert.equal(sent.length, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it("brings the draft back and reports the problem when the delete fails", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes } = setup("Couldn't discard the draft. Try again.");
      const problems: string[] = [];
      deletes.schedule("d1", "t1", (id, problem) => problems.push(`${id}: ${problem}`));
      mock.timers.tick(8000);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(problems, ["d1: Couldn't discard the draft. Try again."]);
      assert.equal(deletes.isDiscarded("d1"), false);
    } finally {
      mock.timers.reset();
    }
  });

  it("tells a watching reader when a draft is discarded, restored or fails", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes } = setup("Couldn't discard the draft. Try again.");
      const seen: number[] = [];
      const stop = deletes.subscribe(() => seen.push(deletes.version()));
      const start = deletes.version();
      deletes.schedule("d1", "t1", () => undefined);
      deletes.schedule("d1", "t1", () => undefined);
      assert.deepEqual(seen, [start + 1]);
      deletes.cancel("d1");
      assert.deepEqual(seen, [start + 1, start + 2]);
      assert.equal(deletes.cancel("d1"), false);
      assert.equal(seen.length, 2);
      deletes.schedule("d2", "t2", () => undefined);
      mock.timers.tick(8000);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(deletes.isDiscarded("d2"), false);
      assert.deepEqual(seen, [start + 1, start + 2, start + 3, start + 4]);
      stop();
      deletes.schedule("d3", "t3", () => undefined);
      assert.equal(seen.length, 4);
      deletes.cancel("d3");
    } finally {
      mock.timers.reset();
    }
  });

  it("hands a failure to the reader showing that thread, and falls back when none claims it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deletes } = setup("Couldn't discard the draft. Try again.");
      const fallback: string[] = [];
      const claimed: string[] = [];
      const stop = deletes.onFailure((id, problem) => {
        if (id !== "d1") return false;
        claimed.push(problem);
        return true;
      });
      deletes.schedule("d1", "t1", (id) => fallback.push(id));
      deletes.schedule("d2", "t2", (id) => fallback.push(id));
      mock.timers.tick(8000);
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      assert.deepEqual(claimed, ["Couldn't discard the draft. Try again."]);
      assert.deepEqual(fallback, ["d2"]);
      stop();
    } finally {
      mock.timers.reset();
    }
  });
});
