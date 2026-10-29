#![cfg(feature = "ts")]
//! Each exported type, doc comments and the generator's banner aside, against the
//! declaration it must keep, under the same name.

use ts_rs::{Config, TS};
use wiretap_capture::{
    CaptureEvent, CaptureEventPatch, CaptureFrameInfo, CaptureKind, CaptureMetadata,
    CaptureProtocol, FrameRowFilter, NewCaptureEvent, TimestampedByte,
};

fn exported<T: TS + 'static>() -> String {
    let ts = T::export_to_string(&Config::new().with_large_int("number")).unwrap();
    let mut out = String::new();
    let mut rest = ts.as_str();
    while let Some(start) = rest.find("/**") {
        out.push_str(&rest[..start]);
        rest = &rest[start + rest[start..].find("*/").unwrap() + 2..];
    }
    out.push_str(rest);
    out.lines()
        .filter(|line| !line.starts_with("// "))
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn capture_kind() {
    assert_eq!(
        exported::<CaptureKind>(),
        r#"export type CaptureKind = "frames" | "bytes";"#
    );
}

#[test]
fn timestamped_byte() {
    assert_eq!(
        exported::<TimestampedByte>(),
        "export type TimestampedByte = { byte: number, timestamp_us: number, bus: number, };"
    );
}

#[test]
fn capture_metadata() {
    assert_eq!(
        exported::<CaptureMetadata>(),
        r#"import type { CaptureKind } from "./CaptureKind"; export type CaptureMetadata = { id: string, kind: CaptureKind, name: string, count: number, start_time_us: number | null, end_time_us: number | null, created_at: number, is_streaming: boolean, owning_session_id: string | null, persistent: boolean, buses: Array<number>, };"#
    );
}

#[test]
fn capture_frame_info() {
    assert_eq!(
        exported::<CaptureFrameInfo>(),
        "export type CaptureFrameInfo = { protocol: string, frame_id: number, max_dlc: number, bus: number, is_extended: boolean, has_dlc_mismatch: boolean, };"
    );
}

#[test]
fn frame_row_filter() {
    assert_eq!(
        exported::<FrameRowFilter>(),
        r#"import type { CaptureProtocol } from "./CaptureProtocol"; export type FrameRowFilter = { frame_id: number | null, is_extended: boolean | null, protocols?: Array<CaptureProtocol>, start_us: number | null, end_us: number | null, };"#
    );
}

#[test]
fn capture_protocol() {
    assert_eq!(
        exported::<CaptureProtocol>(),
        r#"export type CaptureProtocol = "can" | "canfd" | "modbus" | "modbus_rtu" | "serial";"#
    );
}

#[test]
fn capture_event_exports_as_event() {
    assert_eq!(
        exported::<CaptureEvent>(),
        "export type Event = { id: number, ts_us: number, duration_us: number, note: string, created_at_us: number, updated_at_us: number, };"
    );
}

#[test]
fn new_capture_event_exports_as_new_event() {
    assert_eq!(
        exported::<NewCaptureEvent>(),
        "export type NewEvent = { ts_us: number, duration_us: number, note: string, };"
    );
}

#[test]
fn capture_event_patch_exports_as_event_patch() {
    assert_eq!(
        exported::<CaptureEventPatch>(),
        "export type EventPatch = { ts_us: number | null, duration_us: number | null, note: string | null, };"
    );
}
