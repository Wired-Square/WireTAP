// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Listbox, Option } from "../components/Listbox";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const key = (target: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

describe("Listbox", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onPick = vi.fn();
  const onNested = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onPick.mockClear();
    onNested.mockClear();
    act(() => {
      root.render(
        <Listbox>
          <Option onClick={onPick}>one</Option>
          <Option selected mark="radio" onClick={onPick}>two</Option>
          <Option disabled onClick={onPick}>three</Option>
          <Option as="div" onClick={onPick}>
            four
            <button onClick={onNested}>nested</button>
          </Option>
        </Listbox>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

  it("renders the roles, the selected state and the mark", () => {
    const [one, two, three, four] = options();
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(one.getAttribute("aria-selected")).toBe("false");
    expect(two.getAttribute("aria-selected")).toBe("true");
    expect(two.querySelector(".option__mark")).not.toBeNull();
    expect((three as HTMLButtonElement).disabled).toBe(true);
    expect(four.tagName).toBe("DIV");
    expect(four.tabIndex).toBe(0);
  });

  it("arrow keys skip the disabled option and wrap", () => {
    const [one, two, , four] = options();
    one.focus();
    key(one, { key: "ArrowDown" });
    expect(document.activeElement).toBe(two);
    key(two, { key: "ArrowDown" });
    expect(document.activeElement).toBe(four);
    key(four, { key: "ArrowDown" });
    expect(document.activeElement).toBe(one);
    key(one, { key: "End" });
    expect(document.activeElement).toBe(four);
  });

  it("a div option clicks on Enter and Space, but not from a nested control", () => {
    const four = options()[3];
    const nested = four.querySelector("button")!;
    four.focus();
    key(four, { key: "Enter" });
    key(four, { key: " " });
    expect(onPick).toHaveBeenCalledTimes(2);
    nested.focus();
    key(nested, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(2);
  });
});
