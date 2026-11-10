// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import SerialTransmitView from "../apps/transmit/views/SerialTransmitView";
import { useTransmitStore } from "../stores/transmitStore";
import { useSessionStore, type Session } from "../stores/sessionStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function typeKeys(field: HTMLInputElement | HTMLTextAreaElement, keys: string) {
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  for (const key of keys) {
    act(() => {
      setValue.call(field, field.value + key);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

describe("the serial transmit hex fields", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(async () => {
    useSessionStore.setState({
      activeSessionId: "b_serial",
      sessions: {
        b_serial: {
          id: "b_serial",
          lifecycleState: "connected",
          capabilities: { traits: { tx_bytes: true } },
        } as unknown as Session,
      },
    });
    useTransmitStore.getState().resetSerialEditor();
    useTransmitStore.getState().updateSerialEditor({ framingMode: "delimiter", delimiter: [] });
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root.render(<SerialTransmitView />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("reads a typed 0x prefix in the bytes field as a prefix, not a zero byte", () => {
    typeKeys(host.querySelector("textarea")!, "0x0d 0x0a");
    expect(host.querySelector("code")?.textContent).toBe("0D 0A");
  });

  it("reads a delimiter typed one key at a time with a 0x prefix as that byte", () => {
    const field = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.focus();
    typeKeys(field, "0x0d");
    act(() => field.blur());
    expect(useTransmitStore.getState().serialEditor.delimiter).toEqual([0x0d]);
    expect(field.value).toBe("0D");
  });
});
