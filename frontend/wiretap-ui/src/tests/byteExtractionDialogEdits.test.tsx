// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExtractionConfig } from "../apps/discovery/views/serial/serialTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []), Channel: class {} }));

const { default: ByteExtractionDialog } = await import("../apps/discovery/views/serial/ByteExtractionDialog");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ByteExtractionDialog", () => {
  let root: Root;
  const host = document.body.appendChild(document.createElement("div"));

  const render = (initialConfig: ExtractionConfig) =>
    act(() =>
      root.render(
        <ByteExtractionDialog
          isOpen
          onClose={() => {}}
          title="Frame ID"
          sampleFrames={[[1, 2, 3, 4]]}
          initialConfig={initialConfig}
          onApply={() => {}}
          color="cyan"
        />,
      ),
    );

  afterEach(() => act(() => root.unmount()));

  it("keeps an edit when the parent re-renders with an equal default config", async () => {
    root = createRoot(host);
    await render({ startByte: 0, numBytes: 2, endianness: "big" });
    const fromEnd = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => fromEnd.click());
    expect(fromEnd.checked).toBe(true);

    await render({ startByte: 0, numBytes: 2, endianness: "big" });

    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });
});
