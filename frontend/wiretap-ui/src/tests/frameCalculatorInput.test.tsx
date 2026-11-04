import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

const { default: FrameCalculator } = await import("../apps/calculator/FrameCalculator");

describe("the calculator's input", () => {
  it("keeps the case the value was typed in", () => {
    const markup = renderToStaticMarkup(createElement(FrameCalculator));
    const input = markup.match(/<input[^>]*type="text"[^>]*>/)?.[0] ?? "";
    expect(input).not.toBe("");
    expect(input).not.toMatch(/\buppercase\b/);
  });
});
