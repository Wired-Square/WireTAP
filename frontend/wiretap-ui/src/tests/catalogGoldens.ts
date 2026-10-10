// Shared by the P4 catalogue and P5 data goldens: each golden file holds its cases' inputs
// and what the TypeScript returned, rewritten by `npx vitest run -u`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect } from "vitest";

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

export async function expectGolden(file: string, cases: GoldenCase[], dir = "catalog") {
  const text = JSON.stringify({ cases: asJson(cases) }, null, 2) + "\n";
  await expect(text).toMatchFileSnapshot(resolve(fixtures, dir, file));
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
