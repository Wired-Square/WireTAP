// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import FrameDataTable from "../apps/discovery/components/FrameDataTable";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frame = (timestamp_us: number) => ({ protocol: "can", timestamp_us, frame_id: 0x100, dlc: 1, bytes: [0] });

describe("FrameDataTable row numbers", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("numbers a capture's rows by their position in it, not the store's row id", async () => {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () =>
      root.render(
        <FrameDataTable
          frames={[frame(1), frame(2)]}
          captureIndices={[1416, 1417]}
          pageStartIndex={40}
          formatTime={(us) => String(us)}
        />,
      ),
    );

    const numbers = [...host.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);
    expect(numbers).toEqual(["41", "42"]);
  });
});
