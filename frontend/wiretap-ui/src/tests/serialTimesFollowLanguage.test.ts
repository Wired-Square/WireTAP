import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { default: i18n } = await import("../i18n");
const { formatTimestampUs } = await import("../apps/discovery/views/serial/serialTypes");

describe("Discovery's serial times follow the chosen language", () => {
  beforeAll(() => i18n.changeLanguage("fi"));
  afterAll(() => i18n.changeLanguage("en-AU"));

  it("prints the clock in the language and keeps the milli- and microseconds", () => {
    expect(formatTimestampUs(1_780_000_000_250_042)).toMatch(/^\d{2}\.\d{2}\.\d{2}\.250\.042$/);
  });
});
