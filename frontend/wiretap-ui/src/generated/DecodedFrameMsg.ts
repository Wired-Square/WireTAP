// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChecksumVerdict } from "./ChecksumVerdict";
import type { DecodedHeaderField } from "./DecodedHeaderField";
import type { DecodedMirrorVerdict } from "./DecodedMirrorVerdict";
import type { DecodedMuxSelector } from "./DecodedMuxSelector";
import type { DecodedSignalValue } from "./DecodedSignalValue";
import type { DecodedTunnelMessage } from "./DecodedTunnelMessage";

export type DecodedFrameMsg = { bus: number, 
/**
 * The payload this decode came from, for a byte row per mux case.
 */
bytes: Array<number>, checksum?: ChecksumVerdict, dlc: number, frameId: number, headerFields: Array<DecodedHeaderField>, isBrs: boolean, isEsi: boolean, isExtended: boolean, isFd: boolean, 
/**
 * `frame_id` under the catalogue's `frame_id_mask`: the frame it decoded as.
 */
maskedFrameId: number, 
/**
 * Present only on a mirror frame, so absence means "not a mirror".
 */
mirror?: DecodedMirrorVerdict, selectors: Array<DecodedMuxSelector>, signals: Array<DecodedSignalValue>, sourceAddress: number | null, 
/**
 * Host timestamp (µs).
 */
t: number, 
/**
 * The tunnel messages this frame completed.
 */
tunnel?: Array<DecodedTunnelMessage>, };
