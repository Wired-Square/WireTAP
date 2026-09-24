// The page half of wiredai-mcp's `dom` tools. Vendored byte-for-byte from
// lib-wiredai-rs `crates/wiredai-mcp/js/dom-ops.ts`; the Rust side holds the
// same text as `wiredai_mcp::dom::OPS_TS`. No framework or transport imports:
// the consumer carries (op, args) here and the result or thrown error back.

type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

const TEXT_CAP = 200;
const POLL_MS = 50;
const EPSILON = 0.5;

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.left >= outer.left - EPSILON &&
    inner.top >= outer.top - EPSILON &&
    inner.right <= outer.right + EPSILON &&
    inner.bottom <= outer.bottom + EPSILON
  );
}

export function rectInViewport(r: Box, width: number, height: number): boolean {
  return contains({ left: 0, top: 0, right: width, bottom: height }, r);
}

function clips(el: Element): boolean {
  const style = getComputedStyle(el);
  return [style.overflow, style.overflowX, style.overflowY].some((o) => o && o !== "visible");
}

export function clippingAncestor(el: Element): Element | null {
  const rect = el.getBoundingClientRect();
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    if (clips(a) && !contains(a.getBoundingClientRect(), rect)) return a;
  }
  return null;
}

export function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const classes = [...el.classList].map((c) => `.${c}`).join("");
  return el.tagName.toLowerCase() + id + classes;
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden";
}

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
}

function select(selector: string, text?: string): HTMLElement[] {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)];
  return text === undefined ? matches : matches.filter((el) => textOf(el).includes(text));
}

function target(selector: string, text?: string): string {
  return text === undefined ? selector : `${selector} with text "${text}"`;
}

function pick(selector: string, text?: string, index = 0): HTMLElement {
  const matches = select(selector, text);
  const el = matches[index];
  if (!el) throw new Error(`${matches.length} match(es) for ${target(selector, text)}; no index ${index}`);
  return el;
}

function ariaFlag(el: Element, name: string): boolean | null {
  const v = el.getAttribute(name);
  return v === null ? null : v === "true";
}

function formState(el: Element) {
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const checkable = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
  return {
    value: field && !checkable ? el.value : null,
    checked: checkable ? el.checked : ariaFlag(el, "aria-checked"),
    disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
    expanded: ariaFlag(el, "aria-expanded"),
    selected: el instanceof HTMLOptionElement ? el.selected : ariaFlag(el, "aria-selected"),
  };
}

// React tracks an input's value on the element itself, so a plain `el.value =`
// is swallowed as its own write; the prototype's setter is what it observes.
function setNativeValue(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error(`${describe(el)} has no value to set`);
  setter.call(el, value);
}

function query({ selector, text }: { selector: string; text?: string }) {
  const matches = select(selector, text).map((el) => {
    const r = el.getBoundingClientRect();
    const clippedBy = clippingAncestor(el);
    return {
      text: textOf(el).slice(0, TEXT_CAP),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      ...formState(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      inViewport: rectInViewport(r, window.innerWidth, window.innerHeight),
      clippedBy: clippedBy && describe(clippedBy),
    };
  });
  return { matches };
}

function click({ selector, text, index }: { selector: string; text?: string; index?: number }) {
  const el = pick(selector, text, index);
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", at));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", at));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
  return {};
}

function type({ selector, text }: { selector: string; text: string }) {
  const el = pick(selector);
  el.focus();
  setNativeValue(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return {};
}

function press({ key, selector }: { key: string; selector?: string }) {
  const el = selector ? pick(selector) : (document.activeElement ?? document.body);
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  return {};
}

async function waitFor({
  selector,
  text,
  state,
  timeout_ms,
}: {
  selector: string;
  text?: string;
  state: "visible" | "gone";
  timeout_ms: number;
}) {
  const started = performance.now();
  const met = () => {
    const shown = select(selector, text).some(isVisible);
    return state === "gone" ? !shown : shown;
  };
  while (!met()) {
    if (performance.now() - started > timeout_ms) throw new Error(`${target(selector, text)} not ${state} after ${timeout_ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { elapsedMs: Math.round(performance.now() - started) };
}

export const domOps = {
  query,
  click,
  type,
  press,
  wait_for: waitFor,
};

export type DomOp = keyof typeof domOps;

export const DOM_OPS = Object.keys(domOps) as DomOp[];

// `args` is trusted to match the op: the Rust side has already checked it
// against the tool's schema and filled in its defaults.
export async function runDomOp(op: string, args: unknown): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(domOps, op)) throw new Error(`unknown dom op ${op}`);
  return (domOps[op as DomOp] as (args: unknown) => unknown)(args);
}
