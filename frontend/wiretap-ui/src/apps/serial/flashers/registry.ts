// src/apps/serial/flashers/registry.ts
//
// Flasher driver registry. Adding a new chip family = creating a new
// driver record file and adding it here. The unified Flash view consumes
// `getDriver(activeDriverId)` to drive the entire UI.

import { espDriver } from "./espDriver";
import { stm32DfuDriver } from "./stm32DfuDriver";
import { stm32Driver } from "./stm32Driver";
import type { DriverId, FlasherDriver } from "./types";

export const FLASHER_DRIVERS: FlasherDriver<unknown>[] = [
  espDriver as FlasherDriver<unknown>,
  stm32Driver as FlasherDriver<unknown>,
  stm32DfuDriver as FlasherDriver<unknown>,
];

export function getDriver(id: DriverId | null): FlasherDriver<unknown> | null {
  if (!id) return null;
  return FLASHER_DRIVERS.find((d) => d.id === id) ?? null;
}

/** Map a DFU device's `manufacturer` string to a driver id. STM32 DFU
 *  devices use the dedicated `stm32-dfu` driver; everything else falls
 *  through to `null` (no driver — generic DFU isn't implemented yet). */
export function driverIdForDfu(manufacturer: string): DriverId | null {
  if (manufacturer === "STM32 DFU") return "stm32-dfu";
  return null;
}
