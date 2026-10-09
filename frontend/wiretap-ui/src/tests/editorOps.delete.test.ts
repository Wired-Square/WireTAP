import { describe, it, expect, vi, beforeEach } from "vitest";

// editorOps now delegates the actual edit to Rust (`catalog.edit`). These tests
// assert each wrapper builds the correct `EditOp` payload; the comment-preserving
// document semantics are covered by the Rust crate's unit tests.
vi.mock("../api/catalog", () => ({
  editCatalog: vi.fn(async () => "RESULT_TOML"),
  editCatalogOps: vi.fn(async () => "RESULT_TOML"),
}));

import { editCatalog, editCatalogOps } from "../api/catalog";
import {
  deleteSignalToml,
  upsertSignalToml,
  deleteMuxToml,
  deleteMuxCaseToml,
} from "../apps/catalog/editorOps";

const mockEdit = editCatalog as unknown as ReturnType<typeof vi.fn>;
const BASE = "[meta]\nname = \"x\"\nversion = 1\n";

beforeEach(() => {
  mockEdit.mockClear();
  vi.mocked(editCatalogOps).mockClear();
});

describe("deleteSignalToml", () => {
  it("emits RemoveArrayItem against the frame's signals array", async () => {
    const out = await deleteSignalToml(BASE, ["frame", "can", "0x123"], 2);
    expect(out).toBe("RESULT_TOML");
    expect(mockEdit).toHaveBeenCalledWith(BASE, {
      op: "RemoveArrayItem",
      array_path: ["frame", "can", "0x123", "signals"],
      index: 2,
      remove_if_empty: false,
    });
  });

  it("targets a mux-case signals array via its owner path", async () => {
    await deleteSignalToml(BASE, ["frame", "can", "0x123", "mux", "case1"], 0);
    expect(mockEdit).toHaveBeenCalledWith(
      BASE,
      expect.objectContaining({ array_path: ["frame", "can", "0x123", "mux", "case1", "signals"], index: 0 }),
    );
  });
});

describe("upsertSignalToml", () => {
  it("emits UpsertSignal for the frame or mux case that owns the signal", async () => {
    await upsertSignalToml(
      BASE,
      ["frame", "can", "0x123", "mux", "case1", "signals", "2"],
      { name: "B", start_bit: 8, bit_length: 8, byte_order: "little", notes: "two\nlines" },
      null,
    );
    expect(editCatalogOps).toHaveBeenCalledWith(BASE, [
      {
        op: "UpsertSignal",
        owner_path: ["frame", "can", "0x123", "mux", "case1"],
        index: 2,
        signal: { name: "B", start_bit: 8, bit_length: 8, byte_order: "little", notes: "two\nlines" },
      },
    ]);
  });
});

describe("deleteMuxToml", () => {
  it("deletes the mux table at the given path", async () => {
    await deleteMuxToml(BASE, ["frame", "can", "0x123", "mux"]);
    expect(mockEdit).toHaveBeenCalledWith(BASE, {
      op: "DeleteAtPath",
      path: ["frame", "can", "0x123", "mux"],
    });
  });
});

describe("deleteMuxCaseToml", () => {
  it("deletes the targeted case key", async () => {
    await deleteMuxCaseToml(BASE, ["frame", "can", "0x123", "mux"], "case1");
    expect(mockEdit).toHaveBeenCalledWith(BASE, {
      op: "DeleteAtPath",
      path: ["frame", "can", "0x123", "mux", "case1"],
    });
  });
});
