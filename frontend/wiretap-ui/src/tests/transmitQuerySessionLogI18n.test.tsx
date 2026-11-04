// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueueRow } from "../generated/QueueRow";
import type { ValidationCode } from "../generated/ValidationCode";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const { default: i18n } = await import("../i18n");
const { FALLBACK_LANGUAGE, PSEUDO_LANGUAGE } = await import("../locales");
const { default: TransmitQueueView } = await import("../apps/transmit/views/TransmitQueueView");
const { default: ResizableSidebar } = await import("../components/ResizableSidebar");
const { useTransmitStore } = await import("../stores/transmitStore");
const { QUERY_TYPES, queryTypeLabel } = await import("../apps/query/stores/queryStore");
const { describeEvent, kindLabel, KIND_BADGE } = await import("../apps/session-manager/stores/sessionLogStore");
const { default: SessionDetailPanel } = await import("../apps/session-manager/views/SessionDetailPanel");
const { useSessionManagerStore } = await import("../apps/session-manager/stores/sessionManagerStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const queueRow: QueueRow = {
  id: "q1",
  session_id: "f_1",
  profile_id: "p",
  profile_name: "Bench",
  payload: { kind: "can", frame: { frame_id: 1, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false } },
  interval_ms: 100,
  enabled: true,
  group: null,
  origin: "user",
  repeating: false,
  last_error: null,
};

describe("Transmit, Query, Session Manager and Settings labels", () => {
  let root: Root | undefined;

  const render = (element: ReactElement) => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(element));
    return document.body.textContent ?? "";
  };

  beforeEach(async () => {
    await i18n.changeLanguage(PSEUDO_LANGUAGE);
  });

  afterEach(async () => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    useTransmitStore.setState({ queue: [] });
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  it("translates the empty transmit queue", () => {
    const text = render(<TransmitQueueView outputBusToSource={new Map()} />);
    expect(text).toContain("⟦Add frames from the CAN or Serial tab to build a transmit queue.⟧");
    expect(text).toContain("⟦Queue items can repeat at configurable intervals.⟧");
  });

  it("translates the transmit queue's count, header and session tooltip", () => {
    useTransmitStore.setState({ queue: [queueRow] });
    const text = render(<TransmitQueueView outputBusToSource={new Map()} />);
    expect(text).toContain("⟦1 item in queue⟧");
    expect(text).toContain("⟦Frame / Data⟧");
    expect(document.querySelector('[title="⟦Requires an IO session (connect via the CAN tab)⟧"]')).not.toBeNull();
  });

  it("translates the sidebar's collapse toggle", () => {
    render(<ResizableSidebar collapsible>{null}</ResizableSidebar>);
    expect(document.querySelector('[title="⟦Collapse sidebar⟧"]')).not.toBeNull();
  });

  it("names the selected node's detail header as one phrase", () => {
    const noop = () => {};
    const headers = (["session", "source", "app", "edge"] as const).map((type) => {
      useSessionManagerStore.setState({ selectedNode: { id: "x", type } });
      const text = render(
        <SessionDetailPanel
          sessions={[]}
          profiles={[]}
          onStartSession={noop}
          onStopSession={noop}
          onPauseSession={noop}
          onResumeSession={noop}
          onDestroySession={noop}
          onEvictSubscriber={noop}
          onAddSource={noop}
          onRemoveSource={noop}
          onDisableBusMapping={noop}
        />,
      );
      act(() => root?.unmount());
      document.body.innerHTML = "";
      return text.split("⟧")[0] + "⟧";
    });
    expect(headers).toEqual(["⟦Session Details⟧", "⟦Source Details⟧", "⟦App Details⟧", "⟦Connection Details⟧"]);
    useSessionManagerStore.setState({ selectedNode: null });
  });

  it("translates the query types and a session log line", () => {
    expect(queryTypeLabel("gap_analysis")).toBe("⟦Gap Analysis⟧");
    expect(describeEvent({ kind: "created", mode: "recorded", subscriber_count: 1 }, null)).toBe("⟦Session created (⟦Playback⟧)⟧");
    expect(kindLabel("stream_complete")).toBe("⟦Complete⟧");
  });

  it("has an English label for every query type, log kind and profile validation code", async () => {
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
    const missing = (key: string) => !i18n.exists(key);
    expect(QUERY_TYPES.flatMap((type) => [`query:types.${type}.label`, `query:types.${type}.description`]).filter(missing)).toEqual([]);
    expect(Object.keys(KIND_BADGE).filter((kind) => missing(`sessionManager:log.kinds.${kind}`))).toEqual([]);
    const codes: ValidationCode[] = ["nameRequired", "nameDuplicate", "portRequired", "hostRequired", "fieldRequired", "fieldInvalid"];
    expect(codes.filter((code) => missing(`settings:ioProfileDialog.validation.${code}`))).toEqual([]);
    expect([1, 2].map((count) => i18n.t("dialogs:ioSourcePicker.sources.subscribers", { count }))).toEqual([
      "1 subscriber",
      "2 subscribers",
    ]);
  });
});
