// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TestMode } from "./TestMode";
import type { TestRole } from "./TestRole";

export type TestConfig = { mode: TestMode, role: TestRole, duration_sec: number, rate_hz: number, bus: number, use_fd: boolean, use_extended: boolean, };
