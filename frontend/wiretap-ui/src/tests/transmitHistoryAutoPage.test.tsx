// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "transmit_history_count" ? 3 : [])),
}));

import { useTransmitHistoryView } from "../apps/transmit/hooks/useTransmitHistoryView";
import { useTransmitStore } from "../stores/transmitStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let totalCount: number;
function Harness() {
  ({ totalCount } = useTransmitHistoryView({ pageSize: null, sessionId: "f_slcan-1" }));
  return null;
}

describe("Transmit history under an Auto page size", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("counts the history before the table has measured, so the table can render and measure", async () => {
    useTransmitStore.setState({ historyRevision: 3 });
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    expect(totalCount).toBe(3);
  });
});
