// @vitest-environment jsdom

// The behaviour under the primitives — the dismiss stack, focus movement,
// popover placement — is plain TypeScript with no framework in it. These pin
// its contract as DOM outcomes, and the last case pins the "no framework" part.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pushDismissLayer } from "../components/behaviour/dismiss";
import { moveFocusAlong, rememberFocus, trapTab } from "../components/behaviour/focus";
import { placePopover } from "../components/behaviour/placement";

const key = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

describe("dismiss stack", () => {
  const releases: (() => void)[] = [];
  afterEach(() => {
    releases.splice(0).forEach((release) => release());
    document.body.innerHTML = "";
  });
  const push = (layer: Parameters<typeof pushDismissLayer>[0]) => {
    const release = pushDismissLayer(layer);
    releases.push(release);
    return release;
  };

  it("Escape reaches only the layer opened last", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    push({ onDismiss: lower });
    const releaseUpper = push({ onDismiss: upper });
    key(document, { key: "Escape" });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    releaseUpper();
    key(document, { key: "Escape" });
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it("a layer that does nothing still holds the top", () => {
    const lower = vi.fn();
    push({ onDismiss: lower });
    push({ onDismiss: () => {} });
    key(document, { key: "Escape" });
    expect(lower).not.toHaveBeenCalled();
  });

  it("ignores an Escape already handled or mid-composition", () => {
    const onDismiss = vi.fn();
    push({ onDismiss });
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    key(document, { key: "Escape", isComposing: true });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a mousedown outside dismisses, inside does not, and clicks are unwatched without isInside", () => {
    const inside = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(inside, outside);
    const watched = vi.fn();
    const unwatched = vi.fn();
    push({ onDismiss: unwatched });
    push({ onDismiss: watched, isInside: (t) => inside.contains(t) });
    inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(watched).not.toHaveBeenCalled();
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(watched).toHaveBeenCalledTimes(1);
    expect(unwatched).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function strip(): HTMLElement[] {
    const list = document.createElement("div");
    list.innerHTML = '<button role="tab">a</button><button role="tab">b</button><button role="tab" disabled>c</button><button role="tab">d</button>';
    document.body.append(list);
    const tabs = [...list.querySelectorAll<HTMLElement>("button")];
    list.addEventListener("keydown", (e) =>
      moveFocusAlong(e, { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" }, '[role="tab"]:not(:disabled)'),
    );
    return tabs;
  }

  it("arrow keys wrap over the enabled items; Home and End reach the extremes", () => {
    const [a, b, , d] = strip();
    a.focus();
    key(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    key(b, { key: "ArrowRight" });
    expect(document.activeElement).toBe(d);
    key(d, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);
    key(a, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(d);
    key(d, { key: "Home" });
    expect(document.activeElement).toBe(a);
    key(a, { key: "End" });
    expect(document.activeElement).toBe(d);
  });

  it("leaves the arrow keys to a text field inside the list", () => {
    const list = document.createElement("div");
    list.innerHTML = '<button role="tab">a</button><input>';
    document.body.append(list);
    list.addEventListener("keydown", (e) => moveFocusAlong(e, { ArrowRight: 1 }, '[role="tab"]'));
    const input = list.querySelector("input")!;
    input.focus();
    const e = key(input, { key: "ArrowRight" });
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("trapTab wraps at the frame's edges and from the frame itself, and leaves the middle alone", () => {
    const frame = document.createElement("div");
    frame.tabIndex = -1;
    frame.innerHTML = "<button>one</button><button>two</button><button>three</button>";
    document.body.append(frame);
    frame.addEventListener("keydown", trapTab);
    const [one, two, three] = frame.querySelectorAll("button");
    three.focus();
    expect(key(three, { key: "Tab" }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(one);
    expect(key(one, { key: "Tab", shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(three);
    frame.focus();
    key(frame, { key: "Tab" });
    expect(document.activeElement).toBe(one);
    two.focus();
    expect(key(two, { key: "Tab" }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(two);
  });

  it("rememberFocus restores the opener only while it is still in the document", () => {
    const opener = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(opener, other);
    opener.focus();
    const restore = rememberFocus();
    other.focus();
    restore();
    expect(document.activeElement).toBe(opener);
    other.focus();
    opener.remove();
    restore();
    expect(document.activeElement).toBe(other);
  });
});

describe("placePopover", () => {
  const viewport = { width: 1000, height: 600 };
  const size = { width: 200, height: 100 };
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

  it("hangs below the anchor, start edges aligned, with the 2 px gap", () => {
    expect(placePopover(size, { anchor: rect(100, 50, 80, 30) }, viewport)).toEqual({ top: 82, left: 100, width: undefined });
  });

  it("flips above when there is no room below", () => {
    expect(placePopover(size, { anchor: rect(100, 520, 80, 30) }, viewport).top).toBe(418);
  });

  it("aligns the end edge and matches the anchor's width when asked", () => {
    expect(placePopover(size, { anchor: rect(500, 50, 80, 30), align: "end", matchWidth: true }, viewport)).toEqual({
      top: 82,
      left: 380,
      width: 80,
    });
  });

  it("clamps to the viewport with the 4 px margin", () => {
    expect(placePopover(size, { at: { x: 950, y: 580 } }, viewport)).toEqual({ top: 496, left: 796, width: undefined });
    expect(placePopover(size, { at: { x: -20, y: -20 } }, viewport)).toEqual({ top: 4, left: 4, width: undefined });
  });
});

describe("the behaviour module has no framework in it", () => {
  it("imports nothing from react", () => {
    const dir = join(__dirname, "../components/behaviour");
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/from ["']react/);
    }
  });
});
