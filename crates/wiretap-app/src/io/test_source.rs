use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;

use super::{IOCapabilities, IOSource, IOState, TransmitPayload, TransmitResult};

/// Holds a source inside `start` or `stop` until the test lets it go.
#[derive(Default)]
pub(crate) struct Gate {
    entered: Notify,
    released: Notify,
}

impl Gate {
    async fn pass(&self) {
        self.entered.notify_one();
        self.released.notified().await;
    }

    pub(crate) async fn entered(&self) {
        self.entered.notified().await;
    }

    pub(crate) fn release(&self) {
        self.released.notify_one();
    }
}

type OnTransmit = Box<dyn Fn(&str, &TransmitPayload) -> Result<TransmitResult, String> + Send + Sync>;

/// A CAN source that is whatever a test needs it to be.
pub(crate) struct TestSource {
    session_id: String,
    state: IOState,
    start_gate: Option<Arc<Gate>>,
    stop_gate: Option<Arc<Gate>>,
    on_transmit: Option<OnTransmit>,
}

impl TestSource {
    pub(crate) fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.into(),
            state: IOState::Stopped,
            start_gate: None,
            stop_gate: None,
            on_transmit: None,
        }
    }

    pub(crate) fn slow_start(mut self, gate: &Arc<Gate>) -> Self {
        self.start_gate = Some(gate.clone());
        self
    }

    pub(crate) fn slow_stop(mut self, gate: &Arc<Gate>) -> Self {
        self.stop_gate = Some(gate.clone());
        self
    }

    pub(crate) fn transmitting(
        mut self,
        on_transmit: impl Fn(&str, &TransmitPayload) -> TransmitResult + Send + Sync + 'static,
    ) -> Self {
        self.on_transmit = Some(Box::new(move |session_id, payload| Ok(on_transmit(session_id, payload))));
        self
    }

    pub(crate) fn refusing(mut self, error: &str) -> Self {
        let error = error.to_string();
        self.on_transmit = Some(Box::new(move |_, _| Err(error.clone())));
        self
    }
}

#[async_trait]
impl IOSource for TestSource {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::realtime_can().with_tx(self.on_transmit.is_some(), false)
    }

    async fn start(&mut self) -> Result<(), String> {
        if let Some(gate) = &self.start_gate {
            gate.pass().await;
        }
        self.state = IOState::Running;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        if let Some(gate) = &self.stop_gate {
            gate.pass().await;
        }
        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        self.state = IOState::Paused;
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), String> {
        self.state = IOState::Running;
        Ok(())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Ok(())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Ok(())
    }

    fn transmit(&self, payload: &TransmitPayload) -> Result<TransmitResult, String> {
        let on_transmit = self
            .on_transmit
            .as_ref()
            .ok_or("This test source does not transmit")?;
        on_transmit(&self.session_id, payload)
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }
}
