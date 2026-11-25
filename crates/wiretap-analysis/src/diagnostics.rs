//! UDS conversations read out of recorded CAN frames.

use std::collections::BTreeMap;

use serde::Serialize;
use wslib_isotp::{IndistinctSides, IsoTpTap, Side, TapEvent, TapNotice, TimedFrame};
use wslib_uds::{
    identify, orient, Observed, Safety, Sender, Timing, Tracker, Transaction, Unsettled,
};

use crate::source::{FrameSelection, FrameSource};

/// One request, what it asks for, and how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub name: String,
    pub safety: Safety,
    pub transaction: Transaction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub exchanges: Vec<Exchange>,
    /// ECU messages that answer no open request.
    pub unsolicited: Vec<Vec<u8>>,
    pub notices: Vec<TapNotice>,
}

/// A tester and its ECU on one bus, and what they said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub bus: u8,
    pub parties: wslib_uds::Conversation,
    pub transcript: Transcript,
}

/// An id on one bus that exchanged UDS with no one partner settled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UnsettledId {
    pub bus: u8,
    pub unsettled: Unsettled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UdsTraffic {
    pub conversations: Vec<Conversation>,
    pub unsettled: Vec<UnsettledId>,
}

/// The UDS conversations among a source's CAN frames, bus by bus.
pub async fn uds_traffic<S: FrameSource>(
    source: &S,
    newest: Option<usize>,
) -> Result<UdsTraffic, S::Error> {
    let frames = source.frames(&FrameSelection::default(), newest).await?;
    let mut by_bus: BTreeMap<u8, Vec<TimedFrame>> = BTreeMap::new();
    for f in frames.into_iter().filter(|f| f.protocol == "can") {
        by_bus.entry(f.frame.bus).or_default().push(TimedFrame {
            id: f.frame.key.frame_id,
            extended: f.frame.key.is_extended,
            data: f.frame.payload,
            at_us: f.frame.timestamp_us,
        });
    }
    let mut traffic = UdsTraffic::default();
    for (bus, mut frames) in by_bus {
        frames.sort_by_key(|frame| frame.at_us);
        let found = orient(&frames, &Timing::default());
        for parties in found.conversations {
            // A pair `orient` settled always has distinct sides.
            if let Ok(transcript) = transcribe(&parties, &frames) {
                traffic.conversations.push(Conversation {
                    bus,
                    parties,
                    transcript,
                });
            }
        }
        traffic.unsettled.extend(
            found
                .unsettled
                .into_iter()
                .map(|unsettled| UnsettledId { bus, unsettled }),
        );
    }
    Ok(traffic)
}

/// Every request between `parties`, in the order asked. `frames` is the whole
/// bus, since any frame's time can end a quiet message.
fn transcribe(
    parties: &wslib_uds::Conversation,
    frames: &[TimedFrame],
) -> Result<Transcript, IndistinctSides> {
    let mut tap = IsoTpTap::new(parties.tap_config(frames))?;
    let mut tracker = Tracker::new();
    let mut transcript = Transcript::default();
    for event in frames.iter().flat_map(|frame| tap.push(frame)) {
        match event {
            TapEvent::Message(message) => {
                let sender = match message.from {
                    Side::A => Sender::Tester,
                    Side::B => Sender::Ecu,
                };
                for seen in tracker.observe(sender, &message.data, message.last_at_us) {
                    transcript.record(seen);
                }
            }
            TapEvent::Notice(notice) => transcript.notices.push(notice),
        }
    }
    for seen in tracker.finish() {
        transcript.record(seen);
    }
    Ok(transcript)
}

impl Transcript {
    fn record(&mut self, seen: Observed) {
        match seen {
            Observed::Transaction(transaction) => self.exchanges.push(Exchange {
                name: identify(&transaction.request)
                    .map(|identity| identity.to_string())
                    .unwrap_or_default(),
                safety: Safety::of(&transaction.request),
                transaction,
            }),
            Observed::Unsolicited { response, .. } => self.unsolicited.push(response),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    use wslib_isotp::testing::{Conversation as Talk, Responder};
    use wslib_isotp::Framing;
    use wslib_uds::Endpoint;
    use wslib_uds::testing::{Did, Ecu};
    use wslib_uds::{sid, Outcome};

    const TESTER: u32 = 0x7E0;
    const ECU: u32 = 0x7E8;
    const VIN: &[u8; 17] = b"5YJ3E1EA7KF000001";

    const START_US: u64 = 1_700_000_000_000_000;

    fn bench_conversation() -> Vec<TimedFrame> {
        let mut ecu = Ecu::new()
            .with_did(0xF190, Did::readable(VIN.to_vec()))
            .with_did(0x0407, Did::readable([0x12, 0x34]))
            .with_pending(sid::READ_DATA_BY_IDENTIFIER, 1);
        let responder = Responder::new(Framing::default(), move |request: &[u8]| {
            ecu.answer(request)
        });
        let mut talk = Talk::new(TESTER, ECU, false, START_US, responder);
        talk.exchange(&[0x3E, 0x00]);
        talk.exchange(&[0x22, 0xF1, 0x90]);
        talk.exchange(&[0x22, 0x04, 0x07]);
        talk.exchange(&[0x22, 0xBE, 0xEF]);
        talk.exchange(&[0x3E, 0x80]);
        talk.into_frames()
    }

    fn with_periodic_traffic(mut frames: Vec<TimedFrame>) -> Vec<TimedFrame> {
        let periodic: Vec<TimedFrame> = (0..40u64)
            .map(|n| TimedFrame {
                id: 0x132,
                extended: false,
                data: vec![0x10, n as u8, 0x21, 0x30, 0, 0, 0, n as u8],
                at_us: START_US + 500 + n * 700,
            })
            .collect();
        frames.extend(periodic);
        frames.sort_by_key(|frame| frame.at_us);
        frames
    }

    fn traffic_on(bus: u8, frames: Vec<TimedFrame>) -> UdsTraffic {
        let mut source = crate::source::MemorySource::default();
        for frame in frames {
            source.push_at("can", bus, frame.id, frame.extended, frame.at_us, frame.data);
        }
        read(&source)
    }

    fn read(source: &crate::source::MemorySource) -> UdsTraffic {
        let reading = std::pin::pin!(uds_traffic(source, None));
        let Poll::Ready(Ok(traffic)) = reading.poll(&mut Context::from_waker(Waker::noop())) else {
            panic!("a memory source answers at once");
        };
        traffic
    }

    fn only_conversation(traffic: &UdsTraffic) -> &super::Conversation {
        assert_eq!(traffic.unsettled, []);
        let [conversation] = &traffic.conversations[..] else {
            panic!("one conversation, got {traffic:?}");
        };
        conversation
    }

    fn endpoint(id: u32) -> Endpoint {
        Endpoint {
            id,
            address_byte: None,
        }
    }

    #[test]
    fn a_transcript_names_each_request_and_how_it_ended() {
        let traffic = traffic_on(0, with_periodic_traffic(bench_conversation()));
        let transcript = &only_conversation(&traffic).transcript;
        let told: Vec<(&str, Safety, u32, Option<&[u8]>)> = transcript
            .exchanges
            .iter()
            .map(|exchange| {
                let response = match &exchange.transaction.outcome {
                    Outcome::Answered { response, .. } => Some(response.as_slice()),
                    Outcome::Suppressed => None,
                    other => panic!("unexpected outcome {other:?}"),
                };
                (
                    exchange.name.as_str(),
                    exchange.safety,
                    exchange.transaction.pending_responses,
                    response,
                )
            })
            .collect();
        let vin_reply = [&[0x62, 0xF1, 0x90][..], VIN].concat();
        assert_eq!(
            told,
            [
                (
                    "TesterPresent",
                    Safety::ReadOnly,
                    0,
                    Some(&[0x7E, 0x00][..])
                ),
                (
                    "ReadDataByIdentifier DID 0xF190",
                    Safety::ReadOnly,
                    1,
                    Some(&vin_reply[..])
                ),
                (
                    "ReadDataByIdentifier DID 0x0407",
                    Safety::ReadOnly,
                    1,
                    Some(&[0x62, 0x04, 0x07, 0x12, 0x34][..])
                ),
                (
                    "ReadDataByIdentifier DID 0xBEEF",
                    Safety::ReadOnly,
                    1,
                    Some(&[0x7F, 0x22, 0x31][..])
                ),
                ("TesterPresent", Safety::ReadOnly, 0, None),
            ]
        );
        assert!(transcript.unsolicited.is_empty());
        assert!(transcript.notices.is_empty());
    }

    #[test]
    fn a_source_gives_each_bus_its_own_conversations() {
        let mut source = crate::source::MemorySource::default();
        for frame in with_periodic_traffic(bench_conversation()) {
            source.push_at("can", 2, frame.id, frame.extended, frame.at_us, frame.data);
        }
        source.push_at("modbus", 2, TESTER, false, START_US, vec![0x10, 0x14]);
        source.push_at(
            "can",
            0,
            0x132,
            false,
            START_US,
            vec![0x10, 0x14, 0, 0, 0, 0, 0, 0],
        );
        let traffic = read(&source);
        let conversation = only_conversation(&traffic);
        assert_eq!(
            (
                conversation.bus,
                conversation.parties.tester,
                conversation.parties.ecu
            ),
            (2, endpoint(TESTER), endpoint(ECU))
        );
        assert_eq!(conversation.transcript.exchanges.len(), 5);
    }

    #[test]
    fn a_conversation_of_single_frames_alone_is_found() {
        let mut ecu = Ecu::new().with_did(0x0407, Did::readable([0x12, 0x34]));
        let responder = Responder::new(Framing::default(), move |request: &[u8]| {
            ecu.answer(request)
        });
        let mut talk = Talk::new(TESTER, ECU, false, START_US, responder);
        talk.exchange(&[0x3E, 0x00]);
        talk.exchange(&[0x22, 0x04, 0x07]);
        let traffic = traffic_on(0, with_periodic_traffic(talk.into_frames()));
        let conversation = only_conversation(&traffic);
        assert_eq!(conversation.parties.tester, endpoint(TESTER));
        assert_eq!(conversation.transcript.exchanges.len(), 2);
    }

    #[test]
    fn a_transcript_serialises_for_the_frontend() {
        let traffic = traffic_on(0, bench_conversation());
        let json = serde_json::to_value(&traffic).unwrap();
        let conversation = &json["conversations"][0];
        assert_eq!(conversation["parties"]["tester"]["id"], TESTER);
        let exchange = &conversation["transcript"]["exchanges"][0];
        assert_eq!(exchange["safety"], "readOnly");
        assert_eq!(exchange["transaction"]["outcome"]["kind"], "answered");
    }
}
