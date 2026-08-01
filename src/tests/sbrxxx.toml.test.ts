import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { tomlParse } from "../apps/catalog/toml";

// Retained catalogue sample, kept purely as a parser fixture — nothing ships it
const fixturePath = resolve(__dirname, "fixtures/sbrxxx.toml");

describe("sbrxxx.toml", () => {
  it("parses without throwing", () => {
    const text = readFileSync(fixturePath, "utf-8");

    const obj = tomlParse(text);

    expect(obj).toBeTruthy();
    expect(typeof obj).toBe("object");
  });
});
