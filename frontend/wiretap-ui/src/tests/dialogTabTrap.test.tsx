// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Dialog from "../components/Dialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pressTab(target: Element, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("Dialog traps Tab", () => {
  let host: HTMLDivElement;
  let root: Root;
  let frame: HTMLElement;
  let first: HTMLButtonElement;
  let last: HTMLButtonElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <Dialog isOpen>
          <button>One</button>
          <button>Two</button>
        </Dialog>,
      );
    });
    frame = host.querySelector('[role="dialog"]')!;
    [first, last] = host.querySelectorAll("button");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("wraps Tab from the last control to the first", () => {
    last.focus();
    pressTab(last);
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    first.focus();
    pressTab(first, true);
    expect(document.activeElement).toBe(last);
  });

  it("enters the first control from the frame", () => {
    pressTab(frame);
    expect(document.activeElement).toBe(first);
  });

  it("leaves Tab alone between controls", () => {
    first.focus();
    expect(pressTab(first).defaultPrevented).toBe(false);
  });
});
