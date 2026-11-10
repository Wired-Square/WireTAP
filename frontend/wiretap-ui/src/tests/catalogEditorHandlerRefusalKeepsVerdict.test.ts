// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("../api/catalog", () => ({
  editCatalogOps: vi.fn(async (toml: string) => toml),
}));

import { useFrameHandlers } from "../apps/catalog/hooks/handlers/useFrameHandlers";
import { createDefaultFrameFields } from "../apps/catalog/views/frameEditUtils";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import { renderHookOnce } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function saveFrameWithoutIdentifier(verdict: boolean) {
  useCatalogEditorStore.getState().setValidation([], verdict);
  const handlers = renderHookOnce(() =>
    useFrameHandlers({ frameFields: createDefaultFrameFields("can"), setEditingFrame: () => {} }),
  );
  await handlers.handleSaveFrame();
  return useCatalogEditorStore.getState().validation;
}

describe("an editor action the handler refuses", () => {
  it("shows why without marking a valid catalogue invalid", async () => {
    const validation = await saveFrameWithoutIdentifier(true);
    expect(validation.errors.map((e) => e.field)).toEqual(["frame"]);
    expect(validation.isValid).toBe(true);
  });

  it("leaves an invalid catalogue invalid", async () => {
    const validation = await saveFrameWithoutIdentifier(false);
    expect(validation.errors.map((e) => e.field)).toEqual(["frame"]);
    expect(validation.isValid).toBe(false);
  });
});
