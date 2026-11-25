//! Each test runs a Virtual Device with `loopback: true`, which echoes what the
//! tester sends back into the session, and puts the simulated ECU on the far
//! end: it hears the echo and answers into the session's capture.

use std::ops::RangeInclusive;
use std::time::Duration;

use wslib_isotp::testing::Responder;
use wslib_isotp::Framing;
use wslib_uds::testing::{Did, Ecu};
use wslib_uds::{
    sid, DidVerdict, Dtc, DtcRequest, DtcResponse, DtcStatus, Nrc, Response, ServiceVerdict,
};

use super::scan::{Answered, Findings, ScanReport, ScanStatus};
use super::tap::{self, Listen};
use super::*;
use crate::capture_store::{self, CaptureKind, SessionAppender};
use crate::io::{now_us, FrameMessage};
use crate::io_test::tests::open_virtual_loopback;

const TESTER: u32 = 0x7E0;
const ECU: u32 = 0x7E8;
const VIN: &[u8; 17] = b"5YJ3E1EA7KF000001";
const PATIENCE: Duration = Duration::from_secs(10);

async fn bench(session_id: &str, ecu: Option<Ecu>) -> Parties {
    open_virtual_loopback(session_id).await;
    capture_store::create_session_capture(session_id, CaptureKind::Frames, session_id.into());
    if let Some(ecu) = ecu {
        tokio::spawn(answer_as(session_id.to_string(), ecu));
    }
    Parties {
        session_id: session_id.into(),
        bus: 0,
        extended: false,
        tester: TESTER,
        ecu: ECU,
    }
}

async fn answer_as(session_id: String, mut ecu: Ecu) {
    let mut heard = tap::listen(
        &session_id,
        Listen {
            bus: 0,
            extended: false,
            id: Some(TESTER),
        },
    );
    let replies = SessionAppender::spawn(session_id, |_, _| {});
    let mut responder = Responder::new(Framing::default(), move |request: &[u8]| {
        ecu.answer(request)
    });
    while let Some(frame) = heard.frames.recv().await {
        let answer = responder
            .on_frame(&frame.bytes)
            .into_iter()
            .map(|sent| FrameMessage {
                protocol: "can".into(),
                timestamp_us: now_us(),
                frame_id: ECU,
                dlc: sent.data.len() as u16,
                bytes: sent.data,
                direction: Some("rx".into()),
                ..Default::default()
            });
        replies.append(answer.collect());
    }
}

async fn settled(scan_id: &str) -> ScanReport {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let report = scan_report(scan_id).expect("the scan is known");
        if report.status != ScanStatus::Scanning {
            return report;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{scan_id} never settled: {report:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn vin_ecu() -> Ecu {
    Ecu::new()
        .with_did(0xF190, Did::readable(VIN.to_vec()))
        .with_did(0x0407, Did::readable([0x12, 0x34]))
        .with_did(0xF192, Did::readable([0xAA]).needs_security())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_answer_comes_back_whole() {
    let parties = bench("uds_long_answer", Some(vin_ecu())).await;
    let reply = read_data_by_identifier(&parties, vec![0xF190])
        .await
        .unwrap();
    let data = VIN.to_vec();
    assert_eq!(
        reply.event,
        Event::Positive(Response::ReadDataByIdentifier { did: 0xF190, data })
    );
    assert_eq!(reply.bytes, Some([&[0x62, 0xF1, 0x90][..], VIN].concat()));
    crate::io::destroy_session("uds_long_answer", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_too_long_for_one_frame_waits_for_flow_control() {
    let parties = bench("uds_long_request", Some(vin_ecu())).await;
    let reply = read_data_by_identifier(&parties, vec![0x0407, 0x1111, 0x2222, 0xF190])
        .await
        .unwrap();
    let data = [&[0x12, 0x34, 0xF1, 0x90][..], VIN].concat();
    assert_eq!(
        reply.event,
        Event::Positive(Response::ReadDataByIdentifier { did: 0x0407, data })
    );
    crate::io::destroy_session("uds_long_request", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn response_pending_answers_are_waited_out() {
    let ecu = vin_ecu().with_pending(sid::READ_DATA_BY_IDENTIFIER, 2);
    let parties = bench("uds_pending", Some(ecu)).await;
    let reply = read_data_by_identifier(&parties, vec![0x0407])
        .await
        .unwrap();
    assert_eq!(reply.bytes, Some(vec![0x62, 0x04, 0x07, 0x12, 0x34]));
    crate::io::destroy_session("uds_pending", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_did_is_a_negative_answer() {
    let parties = bench("uds_refused", Some(vin_ecu())).await;
    let reply = read_data_by_identifier(&parties, vec![0xBEEF])
        .await
        .unwrap();
    let refusal = Event::Negative {
        service: sid::READ_DATA_BY_IDENTIFIER,
        code: Nrc::REQUEST_OUT_OF_RANGE,
    };
    assert_eq!(
        reply,
        Reply {
            event: refusal,
            bytes: Some(vec![0x7F, 0x22, 0x31])
        }
    );
    let json = serde_json::to_value(&reply).unwrap();
    assert_eq!(
        (json["outcome"].as_str(), json["code"].as_u64()),
        (Some("negative"), Some(0x31))
    );
    crate::io::destroy_session("uds_refused", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn trouble_codes_are_read_by_status() {
    let dtc = Dtc::new(0x01_23_45).unwrap();
    let parties = bench("uds_dtcs", Some(Ecu::new().with_dtc(dtc, 0x09))).await;
    let reply = read_dtc_information(&parties, DtcRequest::ByStatusMask { status_mask: 0x08 })
        .await
        .unwrap();
    let report = DtcResponse::ByStatusMask {
        availability_mask: 0xFF,
        dtcs: vec![DtcStatus { dtc, status: 0x09 }],
    };
    assert_eq!(
        reply.event,
        Event::Positive(Response::ReadDtcInformation { report })
    );
    crate::io::destroy_session("uds_dtcs", false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_ecu_times_out() {
    let parties = bench("uds_silent", None).await;
    let reply = tester_present(&parties).await.unwrap();
    assert_eq!(
        reply,
        Reply {
            event: Event::Timeout {
                service: sid::TESTER_PRESENT
            },
            bytes: None
        }
    );
    crate::io::destroy_session("uds_silent", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_did_scan_and_a_service_scan_report_each_probe() {
    let parties = bench("uds_scans", Some(vin_ecu())).await;

    let dids = start_scan(Plan::dids(parties.clone(), 0xF18F..=0xF192).unwrap())
        .await
        .unwrap();
    let report = settled(&dids).await;
    assert_eq!(report.status, ScanStatus::Complete);
    let Findings::Dids(found) = report.findings else {
        panic!("{:?}", report.findings)
    };
    let verdicts: Vec<_> = found.iter().map(|f| (f.did, f.verdict)).collect();
    assert_eq!(
        verdicts,
        [
            (0xF190, DidVerdict::Present { length: 17 }),
            (0xF192, DidVerdict::Locked)
        ]
    );
    assert_eq!((report.progress.done, report.progress.found), (4, 1));

    let services = start_scan(Plan::services(parties)).await.unwrap();
    let report = settled(&services).await;
    let Findings::Services(found) = report.findings else {
        panic!("{:?}", report.findings)
    };
    let refused = ServiceVerdict::Present {
        code: Nrc::INCORRECT_MESSAGE_LENGTH,
    };
    let verdicts: Vec<_> = found.iter().map(|f| (f.service, f.verdict)).collect();
    assert_eq!(
        verdicts,
        [(0x19, refused), (0x22, refused), (0x3E, refused)]
    );
    crate::io::destroy_session("uds_scans", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_scan_stops_between_probes() {
    let parties = bench("uds_stopped", None).await;
    let scan_id = start_scan(Plan::dids(parties, 0x0000..=0x00FF).unwrap())
        .await
        .unwrap();
    while scan_report(&scan_id).unwrap().progress.done == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    stop_scan(&scan_id).unwrap();
    let report = settled(&scan_id).await;
    assert_eq!(report.status, ScanStatus::Stopped);
    assert!(report.progress.done < report.progress.total, "{report:?}");
    let Findings::Dids(found) = report.findings else {
        panic!("{:?}", report.findings)
    };
    assert!(found
        .iter()
        .all(|f| f.verdict == DidVerdict::Inconclusive { code: None }));
    crate::io::destroy_session("uds_stopped", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_address_scan_names_the_id_that_answered() {
    bench("uds_addresses", Some(Ecu::new())).await;
    let plan = Plan::addresses("uds_addresses".into(), 0, false, 0x7DE..=0x7E1).unwrap();
    let report = settled(&start_scan(plan).await.unwrap()).await;
    assert_eq!(
        report.findings,
        Findings::Addresses(vec![Answered {
            request_id: TESTER,
            response_id: ECU
        }])
    );
    assert_eq!((report.progress.done, report.progress.found), (4, 1));
    crate::io::destroy_session("uds_addresses", false)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_tester_said_is_read_back_out_of_the_capture() {
    let session_id = "uds_read_back";
    let parties = bench(session_id, Some(vin_ecu())).await;
    tester_present(&parties).await.unwrap();
    read_data_by_identifier(&parties, vec![0xF190])
        .await
        .unwrap();
    read_data_by_identifier(&parties, vec![0xBEEF])
        .await
        .unwrap();

    let capture_id = capture_store::get_session_frame_capture_id(session_id).unwrap();
    let deadline = tokio::time::Instant::now() + PATIENCE;
    let names = loop {
        let traffic = crate::capture_db::analyse(&capture_id, async |c| {
            wiretap_analysis::diagnostics::uds_traffic(c, None).await
        })
        .await
        .unwrap()
        .unwrap();
        if let [conversation] = &traffic.conversations[..] {
            let parties = &conversation.parties;
            assert_eq!((parties.tester.id, parties.ecu.id), (TESTER, ECU));
            let names: Vec<String> = conversation
                .transcript
                .exchanges
                .iter()
                .map(|e| e.name.clone())
                .collect();
            if names.len() == 3 {
                break names;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "never read back: {traffic:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(
        names,
        [
            "TesterPresent",
            "ReadDataByIdentifier DID 0xF190",
            "ReadDataByIdentifier DID 0xBEEF"
        ]
    );
    crate::io::destroy_session(session_id, false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tester_goes_with_its_session() {
    let parties = bench("uds_dropped", None).await;
    tester(&parties).await.unwrap();
    crate::io::destroy_session("uds_dropped", false)
        .await
        .unwrap();
    assert!(!testers().keys().any(|p| p.session_id == "uds_dropped"));
    assert_eq!(
        tester_present(&parties).await.unwrap_err(),
        "Session 'uds_dropped' not found"
    );
}

#[tokio::test]
async fn ids_are_checked_before_anything_is_sent() {
    let mut parties = Parties {
        session_id: "uds_none".into(),
        bus: 0,
        extended: false,
        tester: 0x800,
        ecu: ECU,
    };
    assert_eq!(
        tester_present(&parties).await.unwrap_err(),
        "0x800 does not fit in 11 bits"
    );
    parties.tester = ECU;
    assert_eq!(
        tester_present(&parties).await.unwrap_err(),
        "the tester and the ECU need ids of their own"
    );
    assert!(Plan::addresses("uds_none".into(), 0, true, 0..=0x2000_0000).is_err());
}

#[test]
fn a_range_that_runs_backwards_is_refused() {
    let parties = Parties {
        session_id: "uds_none".into(),
        bus: 0,
        extended: false,
        tester: TESTER,
        ecu: ECU,
    };
    assert!(Plan::dids(parties, RangeInclusive::new(5, 1)).is_err());
    assert!(Plan::addresses("uds_none".into(), 0, false, RangeInclusive::new(0x7E7, 0x7E0)).is_err());
}
