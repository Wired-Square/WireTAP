// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CanConfig } from "./CanConfig";
import type { EffectiveDefaults } from "./EffectiveDefaults";
import type { Frame } from "./Frame";
import type { Meta } from "./Meta";
import type { ModbusConfig } from "./ModbusConfig";
import type { NodeDef } from "./NodeDef";
import type { Protocol } from "./Protocol";
import type { SerialConfig } from "./SerialConfig";

/**
 * A fully parsed, resolved catalogue.
 */
export type Catalog = { meta: Meta, 
/**
 * The catalogue's dominant protocol (from `meta.default_frame`, else
 * inferred from which frame sections are present).
 */
protocol: Protocol, can?: CanConfig | null, serial?: SerialConfig | null, modbus?: ModbusConfig | null, frames: Array<Frame>, 
/**
 * Network nodes/peers from the `[node]` table, in key order.
 */
nodes?: Array<NodeDef>, 
/**
 * The served copy of [`Catalog::derived_defaults`], for consumers.
 */
effectiveDefaults: EffectiveDefaults, };
