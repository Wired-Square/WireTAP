// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { IOState } from "./IOState";
import type { SessionMode } from "./SessionMode";
import type { SessionTransition } from "./SessionTransition";
import type { StreamEndReason } from "./StreamEndReason";

export type SessionLogEvent = { "kind": "created", mode: SessionMode, subscriber_count: number, } | { "kind": "joined", subscriber_count: number, } | { "kind": "left", subscriber_count: number, } | { "kind": "destroyed", reset: boolean, } | { "kind": "state", state: IOState, } | { "kind": "transitioned", transition: SessionTransition, mode: SessionMode, } | { "kind": "speed", speed: number, } | { "kind": "reconfigured" } | { "kind": "capture_changed" } | { "kind": "stream_ended", reason: StreamEndReason, capture_count: number | null, } | { "kind": "error", message: string, } | { "kind": "device_connected", source_type: string, address: string, bus: number | null, } | { "kind": "device_probe", source_type: string, address: string, success: boolean, cached: boolean, bus_count: number, error: string | null, } | { "kind": "mcp_connected", client: string, } | { "kind": "mcp_disconnected", client: string, } | { "kind": "stats", state: IOState, subscriber_count: number, frame_count: number, } | { "kind": "cleared" };
