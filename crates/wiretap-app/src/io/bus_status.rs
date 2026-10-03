// crates/wiretap-app/src/io/bus_status.rs
//
// A session's CAN buses in trouble, as their devices last reported them, on the
// session's buses.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use wiretap_io::can::ErrorState;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum BusErrorState {
    Active,
    Warning,
    Passive,
    BusOff,
}

impl From<ErrorState> for BusErrorState {
    fn from(state: ErrorState) -> Self {
        match state {
            ErrorState::Active => Self::Active,
            ErrorState::Warning => Self::Warning,
            ErrorState::Passive => Self::Passive,
            ErrorState::BusOff => Self::BusOff,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BusStatus {
    /// The session's bus, after mapping.
    pub bus: u8,
    pub state: BusErrorState,
    pub no_ack: bool,
    pub tx_errors: Option<u8>,
    pub rx_errors: Option<u8>,
}

impl BusStatus {
    fn is_healthy(&self) -> bool {
        self.state == BusErrorState::Active && !self.no_ack
    }
}

/// Sends a transmit timeout lost; a floor, as `wiretap_io::can::BusState::tx_dropped`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SendsLost {
    pub bus: u8,
    pub count: u32,
}

/// The `BusStatus` push: every bus of the session in trouble, healthy ones left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BusStatusMsg {
    pub buses: Vec<BusStatus>,
    pub sends_lost: Option<SendsLost>,
}

/// Each bus's latest status with the source that reported it, shared between
/// the broker, which lists it, and its merge task, which writes it.
#[derive(Clone, Default)]
pub(crate) struct BusStatusBoard(Arc<Mutex<BTreeMap<u8, (usize, BusStatus)>>>);

impl BusStatusBoard {
    pub(crate) fn buses(&self) -> Vec<BusStatus> {
        self.0
            .lock()
            .map(|board| board.values().map(|(_, status)| status.clone()).collect())
            .unwrap_or_default()
    }

    pub(crate) fn report(
        &self,
        source_idx: usize,
        status: BusStatus,
        tx_dropped: u32,
    ) -> BusStatusMsg {
        let sends_lost = (tx_dropped > 0).then_some(SendsLost {
            bus: status.bus,
            count: tx_dropped,
        });
        if let Ok(mut board) = self.0.lock() {
            if status.is_healthy() {
                board.remove(&status.bus);
            } else {
                board.insert(status.bus, (source_idx, status));
            }
        }
        BusStatusMsg {
            buses: self.buses(),
            sends_lost,
        }
    }

    /// A source that reconnected or ended knows nothing of its buses until it
    /// next reports. `None` when it had none on the board.
    pub(crate) fn forget_source(&self, source_idx: usize) -> Option<BusStatusMsg> {
        self.forget(|idx| idx == source_idx)
    }

    pub(crate) fn clear(&self) -> Option<BusStatusMsg> {
        self.forget(|_| true)
    }

    fn forget(&self, which: impl Fn(usize) -> bool) -> Option<BusStatusMsg> {
        let mut board = self.0.lock().ok()?;
        let before = board.len();
        board.retain(|_, (idx, _)| !which(*idx));
        let changed = board.len() != before;
        drop(board);
        changed.then(|| BusStatusMsg {
            buses: self.buses(),
            sends_lost: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(bus: u8, state: BusErrorState, no_ack: bool) -> BusStatus {
        BusStatus {
            bus,
            state,
            no_ack,
            tx_errors: Some(128),
            rx_errors: Some(0),
        }
    }

    #[test]
    fn a_bus_in_trouble_is_held_until_it_reports_healthy() {
        let board = BusStatusBoard::default();
        let msg = board.report(3, status(4, BusErrorState::Passive, true), 0);
        assert_eq!(msg.buses, vec![status(4, BusErrorState::Passive, true)]);
        assert_eq!(msg.sends_lost, None);

        let msg = board.report(3, status(4, BusErrorState::Active, false), 0);
        assert!(msg.buses.is_empty());
        assert!(board.buses().is_empty());
    }

    #[test]
    fn a_timeout_says_how_many_sends_it_lost_on_which_bus() {
        let msg = BusStatusBoard::default().report(0, status(2, BusErrorState::Warning, true), 7);
        assert_eq!(msg.sends_lost, Some(SendsLost { bus: 2, count: 7 }));
    }

    #[test]
    fn a_source_forgets_only_its_own_buses() {
        let board = BusStatusBoard::default();
        board.report(1, status(0, BusErrorState::BusOff, false), 0);
        board.report(2, status(1, BusErrorState::Warning, true), 0);

        let msg = board
            .forget_source(1)
            .expect("source 1 had a bus on the board");
        assert_eq!(msg.buses, vec![status(1, BusErrorState::Warning, true)]);
        assert_eq!(board.forget_source(1), None);
        assert_eq!(board.clear().map(|m| m.buses), Some(vec![]));
        assert_eq!(board.clear(), None);
    }
}
