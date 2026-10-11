// ui/src/api/decode.ts
//
// `wiretap_decode`'s readings for a CAN filter mask, computed in Rust.

import { invoke } from "@tauri-apps/api/core";
import type { MaskMatch } from "../generated/MaskMatch";

export type { MaskMatch };

/** How many `width`-bit ids `mask` accepts around `id`, and their range. */
export async function canMaskMatch(id: number, mask: number, width: number): Promise<MaskMatch> {
  return invoke<MaskMatch>("can_mask_match_cmd", { id, mask, width });
}
