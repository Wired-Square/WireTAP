// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SignalMappingDescriptor } from "./SignalMappingDescriptor";

export type GeneratorDescriptor = { generator_id: number, name: string, description: string | null, frame_def_id: number, frame_def_name: string, interface_index: number, interface_name: string, period_ms: number, trigger_type: number, trigger_type_name: string, enabled: boolean, mappings: Array<SignalMappingDescriptor>, };
