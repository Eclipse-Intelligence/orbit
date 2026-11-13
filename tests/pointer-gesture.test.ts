import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startPointerGesture, type GestureResult } from "@/lib/pointer-gesture";

type FakeWindow = EventTarget & { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

let fake: FakeWindow;
const original = (globalThis as { window?: unknown }).window;

function pointer(type: string, init: { pointerId?: number; clientX?: number; clientY?: number; buttons?: number }) {
  return Object.assign(new Event(type), { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, ...init });
}

function record() {
  const seen: string[] = [];
  const moves: [number, number][] = [];
  return {
    seen,
    moves,
    handlers: {
      start: () => seen.push("start"),
      move: (x: number, y: number) => moves.push([x, y]),
      end: (result: GestureResult) => seen.push(`end:${result}`),
    },
  };
}

const mouseDown = { pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 };

describe("pointer gestures", () => {
  beforeEach(() => {
    fake = Object.assign(new EventTarget(), { setTimeout, clearTimeout }) as FakeWindow;
    (globalThis as { window?: unknown }).window = fake;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  it("starts after the mouse moves a few pixels and drops on pointerup", () => {
    const { seen, moves, handlers } = record();
    assert.equal(typeof startPointerGesture(mouseDown, handlers), "function");
    fake.dispatchEvent(pointer("pointermove", { clientX: 12, clientY: 10 }));
    assert.deepEqual(seen, []);
    fake.dispatchEvent(pointer("pointermove", { clientX: 20, clientY: 10 }));
    assert.deepEqual(seen, ["start"]);
    assert.deepEqual(moves.at(-1), [20, 10]);
    fake.dispatchEvent(pointer("pointerup", {}));
    assert.deepEqual(seen, ["start", "end:drop"]);
  });

  it("is a tap when the mouse never moves", () => {
    const { seen, handlers } = record();
    startPointerGesture(mouseDown, handlers);
    fake.dispatchEvent(pointer("pointerup", {}));
    assert.deepEqual(seen, ["end:tap"]);
  });

  it("cancels when a move arrives with no button held, as after a lost pointerup", () => {
    const { seen, handlers } = record();
    startPointerGesture(mouseDown, handlers);
    fake.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 10 }));
    fake.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 10, buttons: 0 }));
    assert.deepEqual(seen, ["start", "end:cancel"]);
    fake.dispatchEvent(pointer("pointermove", { clientX: 50, clientY: 10 }));
    fake.dispatchEvent(pointer("pointerup", {}));
    assert.deepEqual(seen, ["start", "end:cancel"]);
  });

  it("ignores a ctrl-click, which opens the context menu on a Mac", () => {
    const { seen, handlers } = record();
    assert.equal(startPointerGesture({ ...mouseDown, ctrlKey: true }, handlers), null);
    fake.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 10 }));
    fake.dispatchEvent(pointer("pointerup", {}));
    assert.deepEqual(seen, []);
  });

  it("can be cancelled by its caller, once", () => {
    const { seen, handlers } = record();
    const cancel = startPointerGesture(mouseDown, handlers);
    fake.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 10 }));
    cancel?.();
    cancel?.();
    fake.dispatchEvent(pointer("pointerup", {}));
    assert.deepEqual(seen, ["start", "end:cancel"]);
  });

  it("follows a touch on the element it started on, without counting an event twice", async () => {
    const { seen, moves, handlers } = record();
    const target = new EventTarget();
    (globalThis as { navigator?: unknown }).navigator ??= {};
    startPointerGesture({ pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 }, handlers, { touchTarget: target });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(seen, ["start"]);
    const move = Object.assign(new Event("touchmove", { cancelable: true }), { touches: [{ clientX: 60, clientY: 80 }] });
    target.dispatchEvent(move);
    fake.dispatchEvent(move);
    assert.equal(moves.filter(([x]) => x === 60).length, 1);
    target.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }));
    assert.deepEqual(seen, ["start", "end:drop"]);
  });
});
