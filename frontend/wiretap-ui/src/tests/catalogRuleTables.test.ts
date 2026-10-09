// Two rule tables shared with the Rust tests (`catalog::tests` and
// `checksums::tests`). A mux row whose columns differ is a disagreement between
// the TypeScript and the crate; the checksum table has one column, which both
// sides must match.

import { describe, it, expect } from "vitest";
import { isMuxCaseKey } from "../utils/muxCaseMatch";
import { CHECKSUM_ALGORITHMS } from "../utils/analysis/checksums";
import { fixtureJson } from "./catalogGoldens";

const { keys } = fixtureJson<{ keys: { key: string; ts: boolean }[] }>("catalog/muxCaseKeys.json");
const { algorithms } = fixtureJson<{ algorithms: { id: string; bytes: number | null }[] }>("catalog/checksumAlgorithms.json");

describe("mux case keys", () => {
  it.each(keys.map((row) => [JSON.stringify(row.key), row] as const))("%s", (_, { key, ts }) => {
    expect(isMuxCaseKey(key)).toBe(ts);
  });
});

describe("checksum algorithm widths", () => {
  it("lists the fixed-width algorithms in the crate's order", () => {
    expect(CHECKSUM_ALGORITHMS.map(({ id, outputBytes }) => ({ id, bytes: outputBytes }))).toEqual(
      algorithms.filter((row) => row.bytes !== null),
    );
  });
});
