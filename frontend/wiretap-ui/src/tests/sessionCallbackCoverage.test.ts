// Every callback sessionStore declares must actually be dispatched by it.
//
// This is the guard for the raw-serial-bytes bug: `onBytes` was declared on
// SessionCallbacks, threaded down from Discovery through useIOSessionManager and
// useIOSession, and registered into the store — which never called it. Every link in the
// chain existed except the last, and a source comment claimed the route worked.
//
// Types cannot catch this. `invokeCallbacks(el, eventType: keyof SessionCallbacks, …)`
// checks that every key it *dispatches* is declared; nothing checks the converse, and a
// declared optional callback with no dispatcher is perfectly well-typed. A behavioural
// test would not have caught it either — it only covers the messages you remember to
// write a case for, and the missing case was the whole bug.
//
// So assert the invariant over the source instead: declared ⊆ dispatched.

import { describe, it, expect } from "vitest";
import SOURCE from "../stores/sessionStore.ts?raw";

/** Keys declared on the `SessionCallbacks` interface. */
function declaredCallbacks(): string[] {
  const block = /export interface SessionCallbacks \{([\s\S]*?)\n\}/.exec(SOURCE);
  if (!block) throw new Error("SessionCallbacks interface not found in sessionStore.ts");

  return [...block[1].matchAll(/^\s*(on[A-Za-z]+)\??:/gm)].map((m) => m[1]);
}

/** Callback names passed to `invokeCallbacks(…, "onX", …)` anywhere in the store. */
function dispatchedCallbacks(): string[] {
  return [...SOURCE.matchAll(/invokeCallbacks\(\s*[^,]+,\s*"(on[A-Za-z]+)"/g)].map((m) => m[1]);
}

describe("sessionStore callback coverage", () => {
  it("finds the callback declarations and dispatches (guards the regexes themselves)", () => {
    // If either extractor silently returns nothing, the invariant below passes vacuously.
    expect(declaredCallbacks().length).toBeGreaterThan(5);
    expect(dispatchedCallbacks().length).toBeGreaterThan(5);
    expect(declaredCallbacks()).toContain("onFrames");
    expect(dispatchedCallbacks()).toContain("onFrames");
  });

  it("dispatches every callback it declares", () => {
    const dispatched = new Set(dispatchedCallbacks());
    const orphaned = declaredCallbacks().filter((name) => !dispatched.has(name));

    expect(orphaned, `declared on SessionCallbacks but never passed to invokeCallbacks`).toEqual([]);
  });

  it("declares every callback it dispatches", () => {
    const declared = new Set(declaredCallbacks());
    const undeclared = dispatchedCallbacks().filter((name) => !declared.has(name));

    expect(undeclared, `dispatched but not declared on SessionCallbacks`).toEqual([]);
  });
});
