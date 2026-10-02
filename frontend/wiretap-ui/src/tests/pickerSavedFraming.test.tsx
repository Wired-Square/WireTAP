// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import { servedTable } from "./fixtures/profileTraits";

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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const slipProfile: IOProfile = {
  id: "serial_slip",
  name: "SLIP port",
  kind: "serial",
  connection: { port: "/dev/ttyUSB0", framing_encoding: "slip" },
};

describe("IO picker framing", () => {
  let root: Root;
  const onStartMultiLoad = vi.fn();

  beforeEach(async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IoSourcePickerDialog
          isOpen
          onClose={() => {}}
          ioProfiles={[slipProfile]}
          selectedId={null}
          selectedIds={["serial_slip"]}
          allowMultiSelect
          onSelect={() => {}}
          onStartMultiLoad={onStartMultiLoad}
        />,
      ),
    );
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("a serial source shows the framing its profile was saved with", () => {
    const framing = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "slip"),
    );
    expect(framing?.value).toBe("slip");
  });

  it("a serial source's saved framing is not sent as a session override", async () => {
    const connect = [...document.querySelectorAll("button")].find((b) => b.textContent === "ioSourcePicker.actions.connect")!;
    await act(async () => connect.click());
    expect(onStartMultiLoad).toHaveBeenCalledOnce();
    expect(onStartMultiLoad.mock.calls[0][2].perInterfaceFraming).toBeUndefined();
  });
});
