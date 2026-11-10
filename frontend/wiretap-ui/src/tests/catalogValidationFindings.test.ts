// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const findings = [
  { field: "frame.serial.0x10.checksum[1].polynomial", message: "crc_custom needs a polynomial from 0 to 0xFFFF" },
  { field: "meta.serial.checksum.algorithm", message: "Unknown checksum algorithm" },
];
vi.mock("../api/catalog", () => ({ validateCatalogWs: vi.fn(async () => ({ valid: false, errors: findings })) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: vi.fn() }));
vi.mock("../apps/catalog/io", () => ({}));

import { useFileHandlers } from "../apps/catalog/hooks/handlers/useFileHandlers";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import { renderHookOnce } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("validating the catalogue", () => {
  it("shows checksum findings at their paths", async () => {
    useCatalogEditorStore.getState().setToml("[meta]\n");
    const handlers = renderHookOnce(() => useFileHandlers({ settings: null, saveFrameIdFormat: "hex" }));
    await handlers.handleValidate();
    const { validation, ui } = useCatalogEditorStore.getState();
    expect(validation).toMatchObject({ errors: findings, isValid: false });
    expect(ui.dialogs.validationErrors).toBe(true);
  });
});
