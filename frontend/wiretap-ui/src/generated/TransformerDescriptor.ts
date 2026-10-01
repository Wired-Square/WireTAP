// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SignalMappingDescriptor } from "./SignalMappingDescriptor";

export type TransformerDescriptor = { transformer_id: number, name: string, description: string | null, source_frame_def_id: number, source_frame_def_name: string, source_interface: number, source_interface_name: string, dest_frame_def_id: number, dest_frame_def_name: string, dest_interface: number, dest_interface_name: string, enabled: boolean, mappings: Array<SignalMappingDescriptor>, };
