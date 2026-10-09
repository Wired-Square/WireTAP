// Two rule tables shared with the Rust tests that check the other column
// (`catalog::tests` and `checksums::tests`); a row whose columns differ is a
// disagreement between the TypeScript and the crate.

import { describe, it, expect } from "vitest";
import { isMuxCaseKey } from "../utils/muxCaseMatch";
import { CHECKSUM_ALGORITHMS, getAlgorithmOutputBytes, type ChecksumAlgorithm } from "../utils/analysis/checksums";
import { fixtureJson } from "./catalogGoldens";

const { keys } = fixtureJson<{ keys: { key: string; ts: boolean }[] }>("catalog/muxCaseKeys.json");
const { algorithms } = fixtureJson<{ algorithms: { id: string; tsListed: boolean; tsBytes: number }[] }>("catalog/checksumAlgorithms.json");

describe("mux case keys", () => {
  it.each(keys.map((row) => [JSON.stringify(row.key), row] as const))("%s", (_, { key, ts }) => {
    expect(isMuxCaseKey(key)).toBe(ts);
  });
});

describe("checksum algorithm widths", () => {
  it.each(algorithms.map((row) => [row.id, row] as const))("%s", (id, { tsListed, tsBytes }) => {
    expect(CHECKSUM_ALGORITHMS.some((a) => a.id === id)).toBe(tsListed);
    expect(getAlgorithmOutputBytes(id as ChecksumAlgorithm)).toBe(tsBytes);
  });

  it("lists no algorithm the table lacks", () => {
    expect(CHECKSUM_ALGORITHMS.map((a) => a.id).filter((id) => !algorithms.some((row) => row.id === id))).toEqual([]);
  });
});
