// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { LayoutRange } from "./LayoutRange";

export type FrameLayout = { 
/**
 * The model's [`Frame::length`](crate::model::Frame::length): a Modbus
 * frame's by its register type.
 */
byteLength: number, ranges: Array<LayoutRange>, };
