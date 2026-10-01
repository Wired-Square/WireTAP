// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TunnelDirection } from "./TunnelDirection";
import type { TunnelDirectionBasis } from "./TunnelDirectionBasis";
import type { TunnelPayload } from "./TunnelPayload";
import type { TunnelProtocol } from "./TunnelProtocol";

/**
 * One Modbus RTU message, from a tunnel or an RTU-framed serial port. A
 * tunnelled message rides the frame that completed it.
 */
export type DecodedTunnelMessage = { 
/**
 * Coil or discrete states; empty unless `payload` is `coils`.
 */
coils: Array<boolean>, 
/**
 * Only ever false under a lenient CRC policy, where the boundary came from
 * the length rules alone and the message may have been guessed.
 */
crcValid: boolean, 
/**
 * The body between the header and the CRC: the only route to the bytes of
 * a function code nothing models.
 */
data: Array<number>, device: number, direction: TunnelDirection, directionBasis: TunnelDirectionBasis, exception: number | null, exceptionLabel: string | null, 
/**
 * The catalogue register frame the values decoded through.
 */
frame: string | null, 
/**
 * How many CAN frames the message spanned.
 */
frames: number, function: number, functionLabel: string, 
/**
 * µs since the request this response answers, when that request was seen.
 */
latencyUs?: number, payload: TunnelPayload, protocol: TunnelProtocol, quantity: number | null, 
/**
 * The reassembled message, CRC included.
 */
raw: Array<number>, 
/**
 * Start register; null when a read response had no request to inherit from.
 */
register: number | null, 
/**
 * Register values; empty unless `payload` is `registers`.
 */
values: Array<number>, };
