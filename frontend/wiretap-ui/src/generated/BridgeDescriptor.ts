// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BridgeFilterDescriptor } from "./BridgeFilterDescriptor";

export type BridgeDescriptor = { bridge_id: number, source_interface: number, dest_interface: number, interface_type: number, source_interface_name: string, dest_interface_name: string, interface_type_name: string, enabled: boolean, default_action: "pass" | "block", filters: Array<BridgeFilterDescriptor>, };
