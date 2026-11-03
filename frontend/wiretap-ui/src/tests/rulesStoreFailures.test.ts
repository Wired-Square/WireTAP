import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/framelinkRules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/framelinkRules")>()),
  framelinkFrameDefAdd: vi.fn(),
  framelinkLabelSet: vi.fn(),
  framelinkPersistSave: vi.fn(),
}));

import { framelinkFrameDefAdd, framelinkLabelSet, framelinkPersistSave } from "../api/framelinkRules";
import { useRulesStore } from "../apps/rules/stores/rulesStore";

const refusal = new Error("device NACK: INVALID_PAYLOAD");

beforeEach(() => {
  vi.mocked(framelinkFrameDefAdd).mockRejectedValue(refusal);
  vi.mocked(framelinkLabelSet).mockRejectedValue(refusal);
  vi.mocked(framelinkPersistSave).mockRejectedValue(refusal);
  useRulesStore.getState().reset();
  useRulesStore.setState({
    device: { deviceId: "dev", label: "Bench", host: "10.0.0.2", port: 120, connecting: false, connected: true, error: null, interfaces: [] },
  });
});

describe("a Rules action the device refuses", () => {
  it("resolves false, so a dialog or editor saving it stays open", async () => {
    await expect(useRulesStore.getState().addFrameDef({ frame_def_id: 1 })).resolves.toBe(false);
  });

  it("names the action and the reason in the banner and the status bar", async () => {
    await useRulesStore.getState().addFrameDef({ frame_def_id: 1 });
    const { error, statusBar } = useRulesStore.getState();
    expect(error).toBe("Adding frame def 0x0001 failed: Error: device NACK: INVALID_PAYLOAD");
    expect(statusBar).toMatchObject({ type: "error", text: error });
  });

  it("leaves the definition out of the unsaved rules", async () => {
    await useRulesStore.getState().addFrameDef({ frame_def_id: 1 });
    expect(useRulesStore.getState().temporaryRules.has("framedef:1")).toBe(false);
  });

  it("reports a label that could not be set", async () => {
    await useRulesStore.getState().setLabel("frame_def", 1, "Engine", null);
    expect(useRulesStore.getState().error).toBe("Setting the label of frame def 0x0001 failed: Error: device NACK: INVALID_PAYLOAD");
  });

  it("keeps the persist message it always had", async () => {
    await useRulesStore.getState().persistSave();
    expect(useRulesStore.getState().statusBar?.text).toBe("Persist failed: Error: device NACK: INVALID_PAYLOAD");
  });
});
