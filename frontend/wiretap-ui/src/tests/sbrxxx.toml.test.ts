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

  // The fixture is the only place a tunnel declaration and a mixed CAN+Modbus
  // frame set go through the TS parser, which is a different implementation
  // from the Rust one that decodes them.
  it("parses the 0x1E0 tunnel declaration and its register frames", () => {
    const obj = tomlParse(readFileSync(fixturePath, "utf-8")) as Record<string, any>;

    expect(obj.frame.can["0x1E0"].tunnel).toEqual({
      protocol: "modbus_rtu",
      device_address: 1,
    });
    expect(obj.frame.modbus.tunnel_4de2_input.register_number).toBe(19938);
    expect(obj.frame.modbus.tunnel_4de2_holding.register_type).toBe("holding");
  });
});
