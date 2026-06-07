// ui/src/utils/modbusRegisters.ts
//
// Helpers for mapping a Modbus signal to its real register and raw byte range.
// A frame is a contiguous block of 16-bit registers starting at a base register;
// each signal occupies one or more of those words at a given bit offset.

/** Real register a signal starts at, given the frame's base register. */
export function signalRegister(baseRegister: number, startBit: number): number {
  return baseRegister + Math.floor(startBit / 16);
}

/** Byte slice [start, start+length) within a frame's raw bytes for one signal. */
export function signalByteRange(startBit: number, bitLength: number): { start: number; length: number } {
  return { start: Math.floor(startBit / 8), length: Math.ceil(bitLength / 8) };
}
