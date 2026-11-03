import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/framelinkRules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/framelinkRules")>()),
  framelinkPersistClear: vi.fn(async () => undefined),
  framelinkFrameDefList: vi.fn(async () => [{ frame_def_id: 1, signals: [] }]),
  framelinkBridgeList: vi.fn(async () => [{ bridge_id: 2 }]),
  framelinkXformList: vi.fn(async () => [{ transformer_id: 3 }]),
  framelinkGenList: vi.fn(async () => [{ generator_id: 4 }]),
  framelinkIndicatorsList: vi.fn(async () => []),
  framelinkSignalsSelectable: vi.fn(async () => [
    { signal_id: 0x200, tier: "user" },
    { signal_id: 0xff01, tier: "device" },
  ]),
}));

import { useRulesStore } from "../apps/rules/stores/rulesStore";

beforeEach(() => {
  useRulesStore.getState().reset();
  useRulesStore.setState({
    device: { deviceId: "dev", label: "Bench", host: "10.0.0.2", port: 120, connecting: false, connected: true, error: null, interfaces: [] },
  });
});

describe("clearing the persisted rules", () => {
  it("marks every rule still on the device as unsaved", async () => {
    expect(await useRulesStore.getState().persistClear()).toBe(true);
    expect([...useRulesStore.getState().temporaryRules].sort()).toEqual(
      ["bridge:2", "framedef:1", "gen:4", "usersig:512", "xform:3"],
    );
  });
});
