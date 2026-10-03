// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { applyBusStatus, useSessionStore, type Session } from "../stores/sessionStore";
import { BusStatusBadges, SendsLostToasts } from "../components/BusStatus";
import type { BusStatus } from "../generated/BusStatus";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noAck: BusStatus = { bus: 1, state: "warning", no_ack: true, tx_errors: 128, rx_errors: 0 };
const busOff: BusStatus = { bus: 2, state: "bus_off", no_ack: false, tx_errors: null, rx_errors: null };

function session(busStatuses: BusStatus[] = []): Session {
  return { id: "f_1", busStatuses, pausedSourceProfileIds: [], originProfileIds: [], capture: {} } as unknown as Session;
}

let root: Root | null = null;
let container: HTMLDivElement;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

beforeEach(() => {
  useSessionStore.setState({ sessions: { f_1: session() }, sendsLost: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("a BusStatus push", () => {
  it("replaces the session's buses with Rust's list", () => {
    applyBusStatus("f_1", { buses: [noAck, busOff], sends_lost: null });
    expect(useSessionStore.getState().sessions.f_1.busStatuses).toEqual([noAck, busOff]);

    applyBusStatus("f_1", { buses: [], sends_lost: null });
    expect(useSessionStore.getState().sessions.f_1.busStatuses).toEqual([]);
    expect(useSessionStore.getState().sendsLost).toEqual([]);
  });

  it("toasts the sends lost once, summing a burst on one bus", () => {
    applyBusStatus("f_1", { buses: [noAck], sends_lost: { bus: 1, count: 3 } });
    applyBusStatus("f_1", { buses: [noAck], sends_lost: { bus: 1, count: 4 } });
    expect(useSessionStore.getState().sendsLost).toEqual([{ sessionId: "f_1", bus: 1, count: 7, noAck: true }]);

    const toasts = render(<SendsLostToasts />).querySelectorAll(".toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toContain("At least 7 sends lost on bus 1 (no ACK)");

    act(() => useSessionStore.getState().dismissSendsLost());
    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });
});

describe("the bus status chip", () => {
  it("names each bus's worst trouble in its tone", () => {
    useSessionStore.setState({ sessions: { f_1: session([noAck, busOff]) } });
    const badges = [...render(<BusStatusBadges sessionId="f_1" />).querySelectorAll(".badge")];
    expect(badges.map((b) => b.textContent)).toEqual(["No ACK", "Bus off"]);
    expect(badges[0].className).toContain("badge--warning");
    expect(badges[1].className).toContain("badge--danger");
    expect(badges[0].getAttribute("title")).toBe("TEC 128 · REC 0");
  });
});
