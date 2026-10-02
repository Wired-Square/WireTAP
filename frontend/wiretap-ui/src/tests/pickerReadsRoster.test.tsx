// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { CaptureMetadata } from "../api/capture";
import type { ActiveSessionInfo } from "../api/io";
import { servedTable } from "./fixtures/profileTraits";

const capture = (id: string, name: string): CaptureMetadata => ({
  id,
  kind: "frames",
  name,
  count: 1,
  start_time_us: 1,
  end_time_us: 2,
  created_at: 1,
  is_streaming: false,
  owning_session_id: null,
  persistent: false,
  buses: [],
});

let orphaned: CaptureMetadata[] = [];
const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case "list_orphaned_captures":
      return orphaned;
    case "list_active_sessions":
      return useSessionStore.getState().roster;
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
const { useCaptureListSync } = await import("../hooks/useCaptureListSync");
const { wsTransport } = await import("../services/wsTransport");
const { MsgType } = await import("../services/wsProtocol");

const pushes = new Map<number, () => void>();
vi.spyOn(wsTransport, "onGlobalMessage").mockImplementation((msgType, handler) => {
  pushes.set(msgType, () => handler(new DataView(new ArrayBuffer(0)), new ArrayBuffer(0)));
  return () => {};
});
vi.spyOn(wsTransport, "onReconnect").mockImplementation(() => () => {});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const gvret = { id: "io_first", name: "First GVRET", kind: "gvret_tcp", connection: {} } as unknown as IOProfile;

const row = (session_id: string, joinable: boolean) =>
  ({ session_id, joinable, source_type: "realtime", state: { type: "Running" }, subscriber_count: 1, broker_configs: [] }) as unknown as ActiveSessionInfo;

const optionNames = () => [...document.querySelectorAll<HTMLElement>("[role=option]")].map((el) => el.textContent ?? "");
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((el) => el.textContent?.includes(`ioSourcePicker.tabs.${name}`));
const polled = () =>
  invoke.mock.calls.filter(([cmd]) => ["list_orphaned_captures", "list_active_sessions", "get_profiles_usage"].includes(cmd));

function PickerWithSync() {
  useCaptureListSync();
  return <IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={[gvret]} selectedId={null} onSelect={() => {}} />;
}

let root: Root;

async function renderPicker() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PickerWithSync />));
  await act(async () => {});
}

beforeEach(() => {
  orphaned = [capture("cap_first", "First capture")];
  useCaptureListStore.setState({ orphaned: [] });
  useSessionStore.setState({
    roster: [row("f_shared", true), row("f_unjoinable", false)],
    profileUsage: {
      io_first: { profile_id: "io_first", session_ids: ["f_shared", "f_other"], session_count: 2, config_locked: true },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  invoke.mockClear();
});

describe("the source picker reads the roster", () => {
  it("offers the roster's joinable sessions and shows which sessions hold a device", async () => {
    await renderPicker();
    await act(async () => tab("sessions")!.click());
    expect(optionNames().some((n) => n.includes("f_shared"))).toBe(true);
    expect(optionNames().some((n) => n.includes("f_unjoinable"))).toBe(false);

    await act(async () => tab("devices")!.click());
    expect(optionNames().find((n) => n.includes("First GVRET"))).toContain("f_other");
  });

  it("follows the roster as the store moves", async () => {
    await renderPicker();
    await act(async () => useSessionStore.setState({ roster: [row("f_shared", true), row("f_joined_later", true)] }));
    await act(async () => tab("sessions")!.click());
    expect(optionNames().some((n) => n.includes("f_joined_later"))).toBe(true);
  });

  it("shows a capture once Rust pushes that the list changed", async () => {
    await renderPicker();
    await act(async () => tab("captures")!.click());
    expect(optionNames().some((n) => n.includes("First capture"))).toBe(true);

    orphaned = [...orphaned, capture("cap_second", "Second capture")];
    await act(async () => pushes.get(MsgType.CaptureListChanged)!());
    expect(optionNames().some((n) => n.includes("Second capture"))).toBe(true);
  });

  it("polls nothing while the Sessions tab is hidden", async () => {
    vi.useFakeTimers();
    await renderPicker();
    await act(async () => tab("devices")!.click());
    invoke.mockClear();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(polled()).toEqual([]);
  });

  it("re-reads the roster for live frame counts while the Sessions tab shows", async () => {
    vi.useFakeTimers();
    await renderPicker();
    await act(async () => tab("sessions")!.click());
    invoke.mockClear();
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(polled().map(([cmd]) => cmd)).toEqual(["list_active_sessions", "list_active_sessions"]);
  });
});
