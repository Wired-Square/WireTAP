// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { CaptureMetadata } from "../api/capture";

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
    case "list_orphaned_captures":
      return [byteCapture];
    case "list_capture_ids":
      return [byteCapture.id];
    case "probe_device":
      return { success: true, source_type: "serial", is_multi_bus: false, bus_count: 1, primary_info: null, secondary_info: null, supports_fd: null, error: null };
    case "list_active_sessions":
    case "get_profiles_usage":
      return [];
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rawPort: IOProfile = {
  id: "serial_raw",
  name: "Raw port",
  kind: "serial",
  connection: { port: "/dev/ttyUSB0" },
};

const withText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text))!;
const click = (selector: string, text: string) => act(async () => withText(selector, text).click());

describe("IO picker capture framing", () => {
  let root: Root;
  const onStartLoad = vi.fn();

  beforeEach(async () => {
    useSessionStore.getState().addKnownCaptureId(byteCapture.id);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IoSourcePickerDialog
          isOpen
          onClose={() => {}}
          ioProfiles={[rawPort]}
          selectedId={byteCapture.id}
          selectedIds={[rawPort.id]}
          onSelect={() => {}}
          onStartLoad={onStartLoad}
        />,
      ),
    );
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("framing picked for a byte capture is not sent once a source is selected instead", async () => {
    await click("button", "framingOptions.modeSlip");
    await click("button", "ioSourcePicker.tabs.devices");
    await click("[role=option]", rawPort.name);
    await click("button", "ioSourcePicker.actions.connect");

    expect(onStartLoad).toHaveBeenCalledOnce();
    expect(onStartLoad.mock.calls[0][0]).toBe(rawPort.id);
    expect(onStartLoad.mock.calls[0][2].framingEncoding).toBeUndefined();
  });
});
