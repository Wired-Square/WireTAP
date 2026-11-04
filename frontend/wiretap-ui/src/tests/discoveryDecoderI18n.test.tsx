// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";
import AnalysisProgressDialog from "../apps/discovery/dialogs/AnalysisProgressDialog";
import { checksumAlgorithmOptions } from "../apps/discovery/views/serial/serialTypes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Discovery and Decoder labels", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  it("names the running tool inside the progress sentence", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<AnalysisProgressDialog isOpen frameCount={12} toolName="Payload Changes" />));
    expect(document.body.textContent).toContain("Running Payload Changes analysis...");
  });

  it("pluralises the frame picker's varying-length warning", () => {
    expect([1, 3].map((count) => i18n.t("common:framePicker.varyingLengths", { count }))).toEqual([
      "1 frame with varying payload lengths",
      "3 frames with varying payload lengths",
    ]);
  });

  it("ends the checksum algorithm options with Unknown", () => {
    expect(checksumAlgorithmOptions(i18n.t).pop()).toEqual({ value: "unknown", label: "Unknown" });
  });
});
