// ui/src/api/decode.ts
//
// `wiretap_decode`'s readings for a Modbus scan and a CAN filter mask,
// computed in Rust.

import { invoke } from "@tauri-apps/api/core";
import type { Endianness } from "../generated/Endianness";
import type { MaskMatch } from "../generated/MaskMatch";
import type { RegisterRead } from "../generated/RegisterRead";
import type { RegisterReading } from "../generated/RegisterReading";

export type { MaskMatch, RegisterReading };

/** Each register's readings, paired with the next address when the scan found it. */
export async function interpretRegisters(registers: RegisterRead[], wordOrder: Endianness): Promise<RegisterReading[]> {
  return invoke<RegisterReading[]>("interpret_registers_cmd", { registers, word_order: wordOrder });
}

/** How many `width`-bit ids `mask` accepts around `id`, and their range. */
export async function canMaskMatch(id: number, mask: number, width: number): Promise<MaskMatch> {
  return invoke<MaskMatch>("can_mask_match_cmd", { id, mask, width });
}
