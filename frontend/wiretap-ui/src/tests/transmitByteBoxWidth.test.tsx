// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { appCss, compile } from "../../scripts/gen-utilities.mjs";
import CanFrameEditor from "../apps/transmit/components/CanFrameEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// JetBrains Mono's advance width is 600 units of a 1000-unit em.
const MONO_ADVANCE_EM = 0.6;
const ROOT_PX = 16;

const COMPONENTS_CSS = appCss();

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const match = COMPONENTS_CSS.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

const declared = (body: string, property: string) => body.match(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`))?.[1].trim();

const toPx = (length: string) =>
  length.endsWith("rem") ? parseFloat(length) * ROOT_PX : length.endsWith("px") ? parseFloat(length) : NaN;

function inputMetrics(classes: string[]) {
  const sizeClass = classes.find((c) => /^input--(xs|sm|lg)$/.test(c));
  const bodies = [ruleBody(".input"), ...(sizeClass ? [ruleBody(`.${sizeClass}`)] : [])];
  const last = (property: string) => bodies.map((b) => declared(b, property)).filter(Boolean).pop()!;
  return {
    paddingX: toPx(last("--input-px")),
    border: toPx(last("border").split(/\s+/)[0]),
    fontSize: toPx(last("font-size")),
  };
}

function utilityWidth(classes: string[]): number {
  for (const c of classes) {
    const width = compile(c)?.decls.find(([property]: [string, string]) => property === "width");
    if (width) return toPx(width[1]);
  }
  throw new Error(`no width utility in ${classes.join(" ")}`);
}

describe("the Transmit editor's data bytes", () => {
  it("a data byte's box fits two hex digits", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<CanFrameEditor />));

    const byteBox = host.querySelector<HTMLInputElement>('input[maxlength="2"]')!;
    const classes = byteBox.className.split(/\s+/);
    expect(classes).toContain("input--mono");

    const { paddingX, border, fontSize } = inputMetrics(classes);
    const contentWidth = utilityWidth(classes) - 2 * (paddingX + border);
    expect(contentWidth).toBeGreaterThanOrEqual(2 * MONO_ADVANCE_EM * fontSize);

    await act(async () => root.unmount());
  });
});
