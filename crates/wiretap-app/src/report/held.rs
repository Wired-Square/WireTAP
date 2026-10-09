// crates/wiretap-app/src/report/held.rs
//
// The last Payload Changes and Frame Order result per capture and window, so an
// export renders what the panel showed rather than a fresh read of a live
// capture. In memory only; dropped when the capture's session is destroyed.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::ReportFormat;
use crate::analysis::{OrderStart, ProtocolOrder};
use crate::byte_roles::PayloadChanges;
use crate::capture_store::ProtocolFrames;

/// A capture, and the window read from it.
pub type WindowKey = (String, String);

#[derive(Default)]
struct Held {
    changes: HashMap<WindowKey, PayloadChanges>,
    orders: HashMap<WindowKey, Vec<ProtocolOrder>>,
}

static HELD: Lazy<Mutex<Held>> = Lazy::new(Default::default);

pub fn window_key(
    capture_id: &str,
    selection: &[ProtocolFrames],
    newest: Option<usize>,
    start: Option<&OrderStart>,
) -> WindowKey {
    let window = serde_json::to_string(&(selection, newest, start)).unwrap_or_default();
    (capture_id.to_string(), window)
}

pub fn hold_changes(key: WindowKey, changes: PayloadChanges) {
    HELD.lock().unwrap().changes.insert(key, changes);
}

pub fn hold_orders(key: WindowKey, orders: Vec<ProtocolOrder>) {
    HELD.lock().unwrap().orders.insert(key, orders);
}

const NOT_HELD: &str = "is no longer held for this capture; run it again, then export";

pub fn render_changes(key: &WindowKey, format: ReportFormat) -> Result<String, String> {
    let held = HELD.lock().unwrap();
    let changes = held.changes.get(key).ok_or_else(|| format!("Payload Changes {NOT_HELD}"))?;
    Ok(super::changes::report(changes).render(format))
}

pub fn render_orders(key: &WindowKey, format: ReportFormat) -> Result<String, String> {
    let held = HELD.lock().unwrap();
    let orders = held.orders.get(key).ok_or_else(|| format!("Frame Order {NOT_HELD}"))?;
    Ok(super::order::report(orders).render(format))
}

pub fn forget_capture(capture_id: &str) {
    let mut held = HELD.lock().unwrap();
    held.changes.retain(|(capture, _), _| capture != capture_id);
    held.orders.retain(|(capture, _), _| capture != capture_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changes(frame_count: usize) -> PayloadChanges {
        PayloadChanges { frame_count, frames: Vec::new(), skipped_frames: 0, mirrors: Vec::new() }
    }

    #[test]
    fn a_report_renders_the_held_result_for_its_window_until_the_capture_is_forgotten() {
        let key = window_key("held-a", &[], Some(10), None);
        assert!(render_changes(&key, ReportFormat::Text).unwrap_err().contains("run it again"));

        hold_changes(key.clone(), changes(7));
        hold_changes(window_key("held-a", &[], Some(20), None), changes(9));
        assert!(render_changes(&key, ReportFormat::Markdown).unwrap().contains("- **Frames read:** 7"));

        hold_changes(key.clone(), changes(8));
        assert!(render_changes(&key, ReportFormat::Markdown).unwrap().contains("- **Frames read:** 8"));

        forget_capture("held-a");
        assert!(render_changes(&key, ReportFormat::Text).is_err());
    }
}
