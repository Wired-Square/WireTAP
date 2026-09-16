// ui/src/components/modbus/modbusScanDefaults.ts
//
// Defaults and bounds for a Modbus discovery sweep.
//
// These are per-scan levers, not persisted settings, so they live here rather
// than in `src/settings/bounds.ts`. Each default mirrors the Rust one in
// `io/modbus_tcp/scanner.rs`; the reasoning is recorded because most of these
// numbers came from a specific device misbehaving in a specific way.

import type { ModbusRegisterType } from "../../api/io";

// Deliberately not `as const`: these seed `useState`, and literal types would
// pin each piece of state to the value it started with.
export const MODBUS_SCAN_DEFAULTS: {
  registerType: ModbusRegisterType;
  startRegister: number;
  endRegister: number;
  interRequestDelayMs: number;
  timeoutMs: number;
  connectSettleMs: number;
  connectSettleWithReconnectMs: number;
  reconnectPerRequest: boolean;
  maxConsecutiveTimeouts: number;
  maxRegisters: number;
  maxRequests: number;
  repeat: number;
  repeatDelayMs: number;
} = {
  registerType: "holding",
  startRegister: 0,
  /** Wide enough for most small devices, narrow enough to finish in seconds. */
  endRegister: 511,
  /** Delay between requests — politeness towards small embedded stacks. */
  interRequestDelayMs: 50,
  /** A device can answer a function code with silence rather than an exception;
   *  this is the only thing that bounds such a request. */
  timeoutMs: 2000,
  /** Pause after connecting before the first request. Cheap stacks need a
   *  moment to be ready; suggested alongside per-request reconnect. */
  connectSettleMs: 0,
  /** Suggested settle time once per-request reconnect is on. */
  connectSettleWithReconnectMs: 150,
  /** Some devices serve exactly one Modbus conversation per socket. */
  reconnectPerRequest: false,
  /** Three silences is conclusive for a whole function code. */
  maxConsecutiveTimeouts: 3,
  /** Guards the fat-fingered 0..65535. */
  maxRegisters: 4096,
  /** Subdivision is super-linear in gap density, so register count alone does
   *  not bound the work — this does. */
  maxRequests: 2000,
  /** Passes over the range. 2 samples each register twice. */
  repeat: 1,
  /** Long enough for slow telemetry to move between passes. */
  repeatDelayMs: 6000,
};

/** Modbus caps a single read at 125 registers, or 2000 coils. */
const MAX_READ_SIZE = { registers: 125, coils: 2000 } as const;

export function maxChunkFor(type: ModbusRegisterType): number {
  return type === "coil" || type === "discrete" ? MAX_READ_SIZE.coils : MAX_READ_SIZE.registers;
}

/** Input bounds for the scan panels. */
export const MODBUS_SCAN_BOUNDS = {
  register: { min: 0, max: 65535 },
  unitId: { min: 0, max: 255 },
  port: { min: 1, max: 65535 },
  delayMs: { min: 0, max: 5000 },
  timeoutMs: { min: 100, max: 30000 },
  settleMs: { min: 0, max: 5000 },
  consecutiveTimeouts: { min: 1, max: 20 },
  maxRequests: { min: 1, max: 100000 },
  repeat: { min: 1, max: 20 },
  repeatDelayMs: { min: 0, max: 600000 },
  /**
   * How often a live poll repeats — not a delay between requests, which is why
   * it cannot borrow `delayMs`. The floor is 1 ms in Rust (zero panics the poll
   * task's timer); 100 ms here because anything faster is a mistake on a device
   * that answers in tens of milliseconds.
   */
  pollIntervalMs: { min: 100, max: 3600000 },
} as const;
