// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import { servedTable } from "./fixtures/profileTraits";
import type { CaptureMetadata } from "../api/capture";
import type { Session } from "../stores/sessionStore";

const byteCapture: CaptureMetadata = {
  id: "cap_bytes",
  kind: "bytes",
  name: "Serial dump",
  count: 64,
  start_time_us: 1,
  end_time_us: 2,
  created_at: 1,
  is_streaming: false,
  owning_session_id: null,
  persistent: false,
  buses: [],
};

const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case "probe_device":
      return { success: true, source_type: "serial", is_multi_bus: false, bus_count: 1, primary_info: null, secondary_info: null, supports_fd: null, error: null };
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
    case "list_profile_traits":
      return servedTable();
    default:
      return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { default: IoSourcePickerDialog } = await import("../dialogs/IoSourcePickerDialog");
const { useSessionStore } = await import("../stores/sessionStore");
const { useCaptureListStore } = await import("../stores/captureListStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rawPort: IOProfile = {
  id: "serial_raw",
  name: "Raw port",
  kind: "serial",
  connection: { port: "/dev/ttyUSB0" },
};

const withText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text));

let root: Root;

async function renderPicker(props: Partial<ComponentProps<typeof IoSourcePickerDialog>>) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={[rawPort]} selectedId={null} onSelect={() => {}} {...props} />),
  );
  await act(async () => {});
}

const click = (el: HTMLElement | undefined) => act(async () => el!.click());
const captureOption = () => withText("[role=option]", byteCapture.name);
const rawPortOption = () => withText("[role=option]", rawPort.name);

// The app is on a session Rust opened on the capture.
const captureSessionId = "c_000001";
beforeEach(() => {
  useSessionStore.setState({
    sessions: { [captureSessionId]: { id: captureSessionId, sourceKind: "capture", capture: { id: byteCapture.id } } as Session },
  });
  useCaptureListStore.setState({ orphaned: [byteCapture] });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("IO picker capture framing", () => {
  beforeEach(() => renderPicker({ selectedId: captureSessionId, selectedIds: [rawPort.id] }));

  it("the picker offers no framing for a byte capture", () => {
    expect(captureOption()).toBeDefined();
    expect(withText("button", "framingOptions.mode")).toBeUndefined();
  });
});

describe("IO picker selection is a capture or ticked sources, never both", () => {
  const onStartLoad = vi.fn();
  const onStartMultiLoad = vi.fn();

  beforeEach(() => {
    onStartLoad.mockClear();
    onStartMultiLoad.mockClear();
  });

  it("selecting a capture unticks every source", async () => {
    await renderPicker({ selectedIds: [rawPort.id], allowMultiSelect: true, onStartLoad, onStartMultiLoad });
    await click(withText("[role=tab]", "ioSourcePicker.tabs.captures"));
    await click(captureOption());
    await click(withText("button", "ioSourcePicker.actions.connect"));
    expect(onStartMultiLoad).not.toHaveBeenCalled();
    expect(onStartLoad).toHaveBeenCalledWith(byteCapture.id, true, expect.anything());
  });

  it("ticking a source deselects the capture", async () => {
    await renderPicker({ selectedId: captureSessionId, allowMultiSelect: true, onStartLoad, onStartMultiLoad });
    await click(withText("[role=tab]", "ioSourcePicker.tabs.devices"));
    await click(rawPortOption());
    await click(rawPortOption());
    await click(withText("[role=tab]", "ioSourcePicker.tabs.captures"));
    expect(captureOption()?.getAttribute("aria-selected")).toBe("false");
  });
});
