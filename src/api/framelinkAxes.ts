// Copyright 2026 Wired Square Pty Ltd
//
// Signal identity-tuple axes, mirrored from framelink-rs `protocol::types`.
// A device signal's control affordance is chosen from these structured codes
// (role/quantity/aspect), never from its display name or unit string.

/** Quantity codes (`QTY_*`). Only the values WireTAP dispatches on are mirrored. */
export const QTY_BOOL = 0x01;
export const QTY_ENUM = 0x02;
export const QTY_DATARATE = 0x0e;

/** Strips the per-second modifier (bit 7) to recover the base quantity. */
export const QTY_BASE_MASK = 0x7f;

/** Aspect codes (`ASPECT_*`) that select a specialised control or ordering. */
export const ASPECT_PARITY = 3;
export const ASPECT_STOP_BITS = 4;
export const ASPECT_DATA_BITS = 5;

/** Interface type codes (`IFACE_*`). Serial ports carry UART-style config. */
export const IFACE_RS485 = 0x03;
export const IFACE_RS232 = 0x04;

export function baseQuantity(quantity: number): number {
  return quantity & QTY_BASE_MASK;
}
