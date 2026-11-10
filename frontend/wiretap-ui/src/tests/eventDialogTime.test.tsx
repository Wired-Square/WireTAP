// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import EventDialog from "../dialogs/EventDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the event dialog's time", () => {
  it("keeps the sub-second part it opened with when the time is edited", async () => {
    const openedUs = new Date(2026, 10, 10, 9, 30, 15).getTime() * 1000 + 123_456;
    const onSave = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <EventDialog isOpen initial={{ timestampUs: openedUs, durationUs: 0, note: "" }} onClose={() => {}} onSave={onSave} />,
      ),
    );

    await act(async () => type(document.querySelector<HTMLInputElement>('input[type="datetime-local"]')!, "2026-11-10T09:30:20"));
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "dialog.save")!.click());

    expect(onSave.mock.calls[0][0].timestampUs).toBe(new Date(2026, 10, 10, 9, 30, 20).getTime() * 1000 + 123_456);
    act(() => root.unmount());
  });
});
