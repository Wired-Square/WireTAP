// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FcVerdict } from "./FcVerdict";
import type { ModbusRegisterType } from "./ModbusRegisterType";

/**
 * One slave's answers across all four read function codes.
 */
export type FcProbeEntry = { unit_id: number, 
/**
 * FC03
 */
holding: FcVerdict, 
/**
 * FC04
 */
input: FcVerdict, 
/**
 * FC01
 */
coil: FcVerdict, 
/**
 * FC02
 */
discrete: FcVerdict, 
/**
 * True if any function code produced a reply.
 */
responded: boolean, 
/**
 * The register types worth sweeping on this unit.
 */
supported_types: Array<ModbusRegisterType>, };
