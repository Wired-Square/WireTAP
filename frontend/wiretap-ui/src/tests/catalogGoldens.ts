// Shared by the P4 catalogue goldens: each golden file holds its cases' inputs
// and what the TypeScript returned, rewritten by `npx vitest run -u`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect } from "vitest";
import type { ChangesFrame } from "../api/byteRoles";
import type { ByteNotes } from "../generated/ByteNotes";
import type { ProtocolOrder } from "../generated/ProtocolOrder";
import type { ChangesResult } from "../stores/discoveryStore";

export type GoldenCase = { name: string; input: unknown; expected: unknown };

const fixtures = resolve(__dirname, "fixtures");

export const fixtureText = (path: string) => readFileSync(resolve(fixtures, path), "utf-8");

export const fixtureJson = <T>(path: string): T => JSON.parse(fixtureText(path)) as T;

/** Plain JSON, with a Map as an object of its entries and a Set as an array. */
export function asJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v,
    ),
  );
}

export async function expectGolden(file: string, cases: GoldenCase[]) {
  const text = JSON.stringify({ cases: asJson(cases) }, null, 2) + "\n";
  await expect(text).toMatchFileSnapshot(resolve(fixtures, "catalog", file));
}

export async function expectGoldenText(file: string, text: string) {
  await expect(text).toMatchFileSnapshot(resolve(fixtures, "catalog", file));
}

/** Renders `hook` once in jsdom and returns what it returned. */
export function renderHookOnce<T>(hook: () => T): T {
  let result: T | undefined;
  const Probe = () => {
    result = hook();
    return null;
  };
  act(() => createRoot(document.createElement("div")).render(createElement(Probe)));
  return result as T;
}

const byteNotes = fixtureJson<{ cases: { name: string; input: { profile: ChangesFrame; isBurstFrame: boolean } }[] }>("analysis/byteNotes.json");
const byteNoteCodes = fixtureJson<Record<string, ByteNotes>>("analysis/byteNoteCodes.json");

/** `byteNotes.json`'s profiles as Payload Changes reports them, each under its own id. */
export const changesResult: ChangesResult = {
  tool: "changes",
  frameCount: 12345,
  frames: byteNotes.cases.map(({ name, input }, i) => ({
    ...input.profile,
    frameId: 0x100 + i,
    notes: byteNoteCodes[name],
    burst: input.isBurstFrame,
  })),
  mirrors: [
    { protocol: "can", groups: [{ keys: [{ frameId: 0x100, isExtended: false }, { frameId: 0x18ff0010, isExtended: true }], sampleCount: 45, matchPercentage: 98, samplePayload: [0, 0x1f, 0xab, 255] }] },
    { protocol: "modbus_rtu", groups: [{ keys: [{ frameId: 0x0103, isExtended: false }, { frameId: 0x0203, isExtended: false }], sampleCount: 3, matchPercentage: 100, samplePayload: [1] }] },
  ],
};

export const frameOrders = fixtureJson<{ orders: ProtocolOrder[] }>("catalog/frameOrder.input.json").orders;
