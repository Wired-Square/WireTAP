// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";
import { FALLBACK_LANGUAGE, PSEUDO_LANGUAGE } from "../locales";
import AddNodeDialog from "../apps/catalog/dialogs/AddNodeDialog";
import MuxEditDialog from "../apps/catalog/dialogs/MuxEditDialog";
import SelectionHeader from "../apps/catalog/layouts/SelectionHeader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noop = () => {};

describe("Catalogue labels", () => {
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
    document.body.innerHTML = "";
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  it("translates the Add Node dialog", () => {
    const text = render(
      <AddNodeDialog open nodeName="" setNodeName={noop} nodeNotes="" setNodeNotes={noop} onCancel={noop} onAdd={noop} />,
    );
    expect(text).toContain("⟦Add Node⟧");
    expect(text).toContain("⟦Node Name⟧");
    expect(text).toContain('⟦Enter a descriptive name for this node (e.g., "inverter", "battery", "motor")⟧');
  });

  it("translates the Add Mux dialog", () => {
    const text = render(
      <MuxEditDialog
        open
        currentMuxPath={[]}
        isAddingNestedMux={false}
        isEditingExistingMux={false}
        fields={{ start_bit: 0, bit_length: 8 }}
        setFields={noop}
        onCancel={noop}
        onSave={noop}
      />,
    );
    expect(text).toContain("⟦Add Mux⟧");
    expect(text).toContain("⟦Start Bit⟧");
    expect(text).toContain("⟦OK⟧");
  });

  it("names a root table and its type in the selection header", () => {
    const text = render(
      <SelectionHeader selectedNode={{ key: "frame", type: "section", path: ["frame"] }} onEdit={noop} onDelete={noop} />,
    );
    expect(text).toContain("⟦frame⟧");
    expect(text).toContain("⟦Table⟧");
    expect(document.querySelector('[title="⟦Edit frame⟧"]')).not.toBeNull();
  });

  it("pluralises the validation summary and the bit layout heading", async () => {
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
    expect([1, 3].map((count) => i18n.t("catalog:validationDialog.issuesFound", { count }))).toEqual([
      "1 issue found",
      "3 issues found",
    ]);
    expect(i18n.t("catalog:muxDialog.layoutPreview", { count: 8 })).toBe("Bit Layout Preview (8 bytes)");
  });
});
