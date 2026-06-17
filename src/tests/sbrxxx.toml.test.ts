import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { tomlParse } from "../apps/catalog/toml";

// Use the example decoder from src-tauri as the test fixture (single source of truth)
const fixturePath = resolve(__dirname, "../../src-tauri/examples/sbrxxx.toml");

describe("sbrxxx.toml", () => {
  it("parses without throwing", () => {
    const text = readFileSync(fixturePath, "utf-8");

    const obj = tomlParse(text);

    expect(obj).toBeTruthy();
    expect(typeof obj).toBe("object");
  });
});
