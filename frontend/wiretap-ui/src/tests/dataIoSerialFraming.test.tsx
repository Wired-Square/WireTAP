// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DataIOView from "../apps/settings/views/DataIOView";
import type { IOProfile } from "../apps/settings/stores/settingsStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const slipProfile = {
  id: "serial_slip",
  name: "SLIP port",
  kind: "serial",
  connection: { port: "/dev/ttyUSB0", framing_encoding: "slip" },
} as IOProfile;

describe("Data IO settings list", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("a serial profile's summary shows the framing encoding it was saved with", () => {
    const host = document.createElement("div");
    root = createRoot(host);
    const noop = () => {};
    act(() =>
      root.render(
        <DataIOView
          ioProfiles={[slipProfile]}
          onAddProfile={noop}
          onEditProfile={noop}
          onDeleteProfile={noop}
          onDuplicateProfile={noop}
          defaultReadProfile={null}
          onToggleDefaultRead={noop}
          adHocProfiles={[]}
          onSaveAdHocProfile={noop}
          onDiscardAdHocProfile={noop}
        />,
      ),
    );
    const framing = [...host.querySelectorAll(".badge")].find((b) =>
      b.textContent?.startsWith("dataIO.summary.framing:"),
    );
    expect(framing?.querySelector(".badge__value")?.textContent).toBe("slip");
  });
});
