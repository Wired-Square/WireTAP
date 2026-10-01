// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SignalDefDescriptor } from "./SignalDefDescriptor";

export type FrameDefDescriptor = { frame_def_id: number, name: string, description: string | null, interface_type: number, interface_type_name: string, can_id: number | null, dlc: number | null, extended: boolean | null, signals: Array<SignalDefDescriptor>, };
