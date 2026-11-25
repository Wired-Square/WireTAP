//! ISO-TP between one tester and one ECU, carried by a session's own transmit
//! path and frame stream.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{sleep, sleep_until, timeout, Instant};
use wslib_isotp::{
    FlowControl, FlowControlError, FlowStatus, Framing, PciKind, Reassembler, Segmenter, StMin,
    Step,
};

use super::tap::{self, Listen, Tap};
use super::Messages;
use crate::io::{self, CanTransmitFrame};

// wslib-isotp's `LinkConfig` defaults.
const N_BS: Duration = Duration::from_secs(1);
const N_CR: Duration = Duration::from_secs(1);
const WAIT_LIMIT: u32 = 10;
const BLOCK_SIZE: u8 = 0;
const ST_MIN: StMin = StMin(0x01);

/// Many ECUs drop a frame shorter than eight bytes; none refuses a padded one.
const PADDING: u8 = Framing::FD_FILL;

pub fn framing() -> Framing {
    let mut framing = Framing::default();
    framing.padding = Some(PADDING);
    framing
}

/// Where a link's frames are sent.
#[derive(Debug, Clone)]
pub struct Route {
    pub session_id: String,
    pub bus: u8,
    pub extended: bool,
    pub id: u32,
}

impl Route {
    pub async fn send(&self, data: Vec<u8>) -> Result<(), String> {
        let frame = CanTransmitFrame {
            frame_id: self.id,
            data,
            bus: self.bus,
            is_extended: self.extended,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };
        let sent = io::transmit_frame_when_ready(&self.session_id, &frame).await?;
        match sent.success {
            true => Ok(()),
            false => Err(sent.error.unwrap_or_else(|| "transmit failed".into())),
        }
    }
}

type Flow = Result<FlowControl, FlowControlError>;

pub struct Link {
    route: Route,
    flow: mpsc::UnboundedReceiver<Flow>,
    messages: mpsc::UnboundedReceiver<Vec<u8>>,
    receiving: Arc<AtomicBool>,
    receiver: tokio::task::JoinHandle<()>,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.receiver.abort();
    }
}

impl Link {
    /// Sends on `route` and receives on `rx_id`, on the route's bus.
    pub fn open(route: Route, rx_id: u32) -> Self {
        let listen = Listen {
            bus: route.bus,
            extended: route.extended,
            id: Some(rx_id),
        };
        let tap = tap::listen(&route.session_id, listen);
        let (flow_tx, flow) = mpsc::unbounded_channel();
        let (messages_tx, messages) = mpsc::unbounded_channel();
        let receiving = Arc::new(AtomicBool::new(false));
        let receiver = tokio::spawn(receive(
            tap,
            route.clone(),
            flow_tx,
            messages_tx,
            receiving.clone(),
        ));
        Self {
            route,
            flow,
            messages,
            receiving,
            receiver,
        }
    }

    /// Forgets messages that arrived after their request was given up on.
    pub fn discard_late(&mut self) {
        while self.messages.try_recv().is_ok() {}
        while self.flow.try_recv().is_ok() {}
    }

    pub async fn send(&mut self, message: &[u8]) -> Result<(), String> {
        let framing = framing();
        let mut frames = Segmenter::with_framing(message, &framing).map_err(|e| e.to_string())?;
        self.route.send(frames.first()).await?;
        while frames.len() > 0 {
            let cts = self.continue_to_send().await?;
            let block = match cts.block_size {
                BLOCK_SIZE => usize::MAX,
                size => size.into(),
            };
            for (n, frame) in frames.by_ref().take(block).enumerate() {
                if n > 0 {
                    sleep(cts.st_min.duration()).await;
                }
                self.route.send(frame).await?;
            }
        }
        Ok(())
    }

    async fn continue_to_send(&mut self) -> Result<FlowControl, String> {
        for _ in 0..=WAIT_LIMIT {
            let flow = timeout(N_BS, self.flow.recv())
                .await
                .map_err(|_| "no flow control within N_Bs")?
                .ok_or("the link is closed")?
                .map_err(|e| e.to_string())?;
            match flow.status {
                FlowStatus::ContinueToSend => return Ok(flow),
                FlowStatus::Overflow => {
                    return Err("the receiver has no room for the message".into())
                }
                FlowStatus::Wait => {}
            }
        }
        Err("too many flow control waits in a row".into())
    }
}

impl Messages for Link {
    type Message = Vec<u8>;

    async fn next(&mut self) -> Option<Vec<u8>> {
        self.messages.recv().await
    }

    /// A first frame has arrived and its message is not yet whole or abandoned.
    fn is_receiving(&self) -> bool {
        self.receiving.load(Ordering::Relaxed)
    }
}

/// Never awaits a send: a flow control goes out on a task of its own.
async fn receive(
    mut tap: Tap,
    route: Route,
    flow: mpsc::UnboundedSender<Flow>,
    messages: mpsc::UnboundedSender<Vec<u8>>,
    receiving: Arc<AtomicBool>,
) {
    let framing = framing();
    let mut reassembler = Reassembler::with_framing(BLOCK_SIZE, ST_MIN, framing);
    let mut n_cr: Option<Instant> = None;
    loop {
        tokio::select! {
            frame = tap.frames.recv() => {
                let Some(frame) = frame else { return };
                if framing.classify(&frame.bytes) == Some(PciKind::FlowControl) {
                    let _ = flow.send(framing.parse_flow_control(&frame.bytes));
                    continue;
                }
                match reassembler.on_frame(&frame.bytes).step {
                    Step::Nothing => {}
                    Step::Accepted => n_cr = Some(Instant::now() + N_CR),
                    Step::SendFlowControl(control) => {
                        let (route, data) = (route.clone(), framing.encode_flow_control(&control));
                        tokio::spawn(async move {
                            if let Err(e) = route.send(data).await {
                                tlog!("[uds] flow control on 0x{:X} not sent: {e}", route.id);
                            }
                        });
                        n_cr = Some(Instant::now() + N_CR);
                    }
                    Step::Message(message) => {
                        let _ = messages.send(message);
                    }
                }
            }
            () = sleep_until(n_cr.unwrap_or_else(Instant::now)), if n_cr.is_some() => reassembler.reset(),
        }
        if !reassembler.is_receiving() {
            n_cr = None;
        }
        receiving.store(reassembler.is_receiving(), Ordering::Relaxed);
    }
}
