//! Received CAN frames on one bus of a session, as they reach its capture.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use once_cell::sync::Lazy;
use tokio::sync::mpsc;

use crate::io::FrameMessage;

/// The frames a tap hears: one bus, one id width, and one id or all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listen {
    pub bus: u8,
    pub extended: bool,
    pub id: Option<u32>,
}

impl Listen {
    fn hears(&self, frame: &FrameMessage) -> bool {
        frame.protocol == "can"
            && frame.bus == self.bus
            && frame.is_extended == self.extended
            && frame.direction.as_deref() != Some("tx")
            && self.id.is_none_or(|id| frame.frame_id == id)
    }
}

type Taps = HashMap<String, Vec<(u64, Listen, mpsc::UnboundedSender<FrameMessage>)>>;

static TAPS: Lazy<Mutex<Taps>> = Lazy::new(Default::default);
static NEXT_TAP: AtomicU64 = AtomicU64::new(1);

fn taps() -> MutexGuard<'static, Taps> {
    TAPS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Dropping it removes it.
pub struct Tap {
    session_id: String,
    id: u64,
    pub frames: mpsc::UnboundedReceiver<FrameMessage>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        let mut taps = taps();
        if let Some(list) = taps.get_mut(&self.session_id) {
            list.retain(|(id, ..)| *id != self.id);
            if list.is_empty() {
                taps.remove(&self.session_id);
            }
        }
    }
}

pub fn listen(session_id: &str, listen: Listen) -> Tap {
    let (tx, frames) = mpsc::unbounded_channel();
    let id = NEXT_TAP.fetch_add(1, Ordering::Relaxed);
    taps()
        .entry(session_id.to_string())
        .or_default()
        .push((id, listen, tx));
    Tap {
        session_id: session_id.to_string(),
        id,
        frames,
    }
}

/// Called with every batch a session's capture is handed; it never waits.
pub fn hand_over(session_id: &str, frames: &[FrameMessage]) {
    let taps = taps();
    let Some(list) = taps.get(session_id) else {
        return;
    };
    for frame in frames {
        for (_, listen, tx) in list {
            if listen.hears(frame) {
                let _ = tx.send(frame.clone());
            }
        }
    }
}
