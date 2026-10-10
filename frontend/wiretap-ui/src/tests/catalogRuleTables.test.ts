// The checksum rule table shared with the Rust tests (`checksums::tests`): one
// column, which both sides must match.

import { describe, it, expect } from "vitest";
import { CHECKSUM_ALGORITHMS } from "../utils/analysis/checksums";
import { fixtureJson } from "./catalogGoldens";

const { algorithms } = fixtureJson<{ algorithms: { id: string; bytes: number | null }[] }>("catalog/checksumAlgorithms.json");

describe("checksum algorithm widths", () => {
  it("lists the fixed-width algorithms in the crate's order", () => {
    expect(CHECKSUM_ALGORITHMS.map(({ id, outputBytes }) => ({ id, bytes: outputBytes }))).toEqual(
      algorithms.filter((row) => row.bytes !== null),
    );
  });
});
