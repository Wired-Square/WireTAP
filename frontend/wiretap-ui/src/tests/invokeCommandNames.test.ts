import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LIB_RS = readFileSync(resolve(__dirname, "../../../../crates/wiretap-app/src/lib.rs"), "utf-8");

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!../tests/**", "!../generated/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function registeredCommands(): Set<string> {
  const handler = /generate_handler!\[([\s\S]*?)\]\)/.exec(LIB_RS)?.[1] ?? "";
  return new Set([...handler.matchAll(/(?:::)?([a-z_0-9]+),\s*$/gm)].map((m) => m[1]));
}

function invokedCommands(): Map<string, string> {
  const invoked = new Map<string, string>();
  for (const [file, text] of Object.entries(SOURCES)) {
    for (const m of text.matchAll(/\binvoke(?:<[^(]*?>)?\(\s*"([^"]+)"/g)) invoked.set(m[1], file);
  }
  return invoked;
}

describe("invoke command names", () => {
  it("finds the registered and invoked commands", () => {
    expect(registeredCommands().size).toBeGreaterThan(100);
    expect(registeredCommands()).toContain("evict_session_subscriber_cmd");
    expect(invokedCommands().size).toBeGreaterThan(100);
  });

  it("every command the frontend invokes is registered with the Rust handler", () => {
    const registered = registeredCommands();
    const unregistered = [...invokedCommands()]
      .filter(([name]) => !registered.has(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(unregistered).toEqual([]);
  });
});
