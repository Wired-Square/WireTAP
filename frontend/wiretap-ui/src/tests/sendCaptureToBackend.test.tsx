// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "api_list_databases") return [];
    if (command === "api_import_capture") throw "Only CAN frames can be sent to a backend; this capture holds modbus";
    return undefined;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../hooks/useAllIOProfiles", () => ({
  useAllIOProfiles: () => [{ id: "gw", name: "Gateway", kind: "wiretap", connection: {} }],
}));

import SendCaptureToBackendDialog from "../dialogs/SendCaptureToBackendDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Send capture to backend", () => {
  it("a refused capture creates no database", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => {
      root.render(<SendCaptureToBackendDialog isOpen onClose={() => {}} captureId="c1" captureName="mixed" />);
    });

    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => type(document.querySelector<HTMLInputElement>('input[placeholder="vehicle_2"]')!, "fresh"));
    const upload = [...document.querySelectorAll("button")].find((b) => b.textContent === "sendToBackend.upload")!;
    await act(async () => upload.click());

    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).toContain("api_import_capture");
    expect(commands).not.toContain("api_create_database");
    act(() => root.unmount());
  });
});
