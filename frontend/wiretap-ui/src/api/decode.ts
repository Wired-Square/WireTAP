// ui/src/api/decode.ts
//
// `wslib_bits`' readings for the Frame Calculator, a Modbus scan and a CAN
// filter mask, computed in Rust.

import { invoke } from "@tauri-apps/api/core";
import type { Endianness } from "../generated/Endianness";
import type { GroupedValue } from "../generated/GroupedValue";
import type { GroupOrder } from "../generated/GroupOrder";
import type { Grouping } from "../generated/Grouping";
import type { MaskMatch } from "../generated/MaskMatch";
import type { RegisterRead } from "../generated/RegisterRead";
import type { RegisterReading } from "../generated/RegisterReading";

export type { GroupedValue, GroupOrder, Grouping, MaskMatch, RegisterReading };

export async function decodeGroups(bytes: number[], grouping: Grouping, order: GroupOrder): Promise<GroupedValue[]> {
  return invoke<GroupedValue[]>("decode_groups_cmd", { bytes, grouping, order });
}

/** Each register's readings, paired with the next address when the scan found it. */
export async function interpretRegisters(registers: RegisterRead[], wordOrder: Endianness): Promise<RegisterReading[]> {
  return invoke<RegisterReading[]>("interpret_registers_cmd", { registers, word_order: wordOrder });
}

/** How many `width`-bit ids `mask` accepts around `id`, and their range. */
export async function canMaskMatch(id: number, mask: number, width: number): Promise<MaskMatch> {
  return invoke<MaskMatch>("can_mask_match_cmd", { id, mask, width });
}
