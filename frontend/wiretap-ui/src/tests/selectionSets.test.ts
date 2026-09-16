// Selection-set identity across a save/reload.
//
// Sets used to persist bare numeric ids, so a mixed-protocol selection could not come
// back: CAN 0x100 and Modbus register 256 collapsed to one 256, and reloading guessed a
// single protocol for the lot. New sets carry composite keys; old ones still load.

import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async (key: string) => store.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
}));

import {
  addSelectionSet,
  updateSelectionSet,
  getAllSelectionSets,
  selectionSetKeys,
  selectionSetSize,
  type SelectionSet,
} from "../utils/selectionSets";

/** A set as written by a build before frame keys existed. */
const legacy: SelectionSet = {
  id: "ss_old",
  name: "old",
  frameIds: [256, 257],
  selectedIds: [256],
  createdAt: 0,
};

describe("selectionSetKeys", () => {
  it("prefers stored keys over the numeric fallback", () => {
    const set: SelectionSet = {
      ...legacy,
      frameKeys: ["can:256", "modbus:256"],
      selectedKeys: ["modbus:256"],
    };

    expect(selectionSetKeys(set, "can")).toEqual({
      all: ["can:256", "modbus:256"],
      selected: ["modbus:256"],
    });
  });

  it("guesses the fallback protocol for a set that predates keys", () => {
    expect(selectionSetKeys(legacy, "modbus")).toEqual({
      all: ["modbus:256", "modbus:257"],
      selected: ["modbus:256"],
    });
  });

  it("treats a keyed set with no selection subset as fully selected", () => {
    const set: SelectionSet = { ...legacy, frameKeys: ["can:256"] };
    expect(selectionSetKeys(set, "can").selected).toEqual(["can:256"]);
  });
});

describe("selectionSetSize", () => {
  it("counts identities, not deduplicated numbers", () => {
    const set: SelectionSet = {
      ...legacy,
      frameIds: [256],
      selectedIds: [256],
      frameKeys: ["can:256", "modbus:256"],
      selectedKeys: ["can:256", "modbus:256"],
    };

    expect(selectionSetSize(set)).toEqual({ total: 2, selected: 2 });
    expect(selectionSetSize(legacy)).toEqual({ total: 2, selected: 1 });
  });
});

describe("persistence", () => {
  beforeEach(() => store.clear());

  it("round-trips a mixed-protocol selection", async () => {
    const saved = await addSelectionSet("mixed", ["can:256", "modbus:256"], ["modbus:256"]);

    const [reloaded] = await getAllSelectionSets();
    expect(reloaded.id).toBe(saved.id);
    expect(selectionSetKeys(reloaded, "can")).toEqual({
      all: ["can:256", "modbus:256"],
      selected: ["modbus:256"],
    });
  });

  it("still writes the numeric arrays, deduplicated, for older builds", async () => {
    await addSelectionSet("mixed", ["can:256", "modbus:256"], ["modbus:256"]);

    const [reloaded] = await getAllSelectionSets();
    expect(reloaded.frameIds).toEqual([256]);
    expect(reloaded.selectedIds).toEqual([256]);
  });

  it("keeps the numeric arrays in step when only the keys are updated", async () => {
    const saved = await addSelectionSet("mixed", ["can:256"], ["can:256"]);

    await updateSelectionSet(saved.id, {
      frameKeys: ["can:256", "can:257"],
      selectedKeys: ["can:257"],
    });

    const [reloaded] = await getAllSelectionSets();
    expect(reloaded.frameIds).toEqual([256, 257]);
    expect(reloaded.selectedIds).toEqual([257]);
  });

  it("leaves a legacy set loadable after an unrelated update", async () => {
    store.set("selectionSets.all", [legacy]);

    await updateSelectionSet(legacy.id, { lastUsedAt: 1 });

    const [reloaded] = await getAllSelectionSets();
    expect(reloaded.frameKeys).toBeUndefined();
    expect(selectionSetKeys(reloaded, "can").all).toEqual(["can:256", "can:257"]);
  });
});
