use wiretap_analysis::dashboard::{format_value, SignalValueFormat, ValueFormat};
use wslib_bits::{BitOrder, Endianness};
use wslib_wiretap_catalogue::decode::decode_signal;
use wslib_wiretap_catalogue::Signal;

fn signal(factor: Option<f64>, offset: Option<f64>, precision: Option<u8>) -> Signal {
    Signal {
        name: Some("s".into()),
        start_bit: Some(0),
        bit_length: Some(8),
        factor,
        offset,
        precision,
        ..Signal::default()
    }
}

const LITTLE: BitOrder = BitOrder::Registers { endianness: Endianness::Little, word_order: None };

#[test]
fn a_computed_sample_reads_as_the_signals_decoded_readout() {
    for sig in [
        signal(None, None, None),
        signal(Some(0.1), Some(-40.0), None),
        signal(Some(0.25), None, None),
        signal(Some(0.1), None, Some(2)),
        signal(Some(3.0), Some(0.5), Some(0)),
    ] {
        let format = SignalValueFormat::of(&sig);
        for raw in 0..=255u8 {
            let decoded = decode_signal(&[raw], &sig, "s", LITTLE);
            assert_eq!(format_value(decoded.scaled, format.sample), decoded.display, "{sig:?} raw {raw}");
        }
    }
}

#[test]
fn a_sample_off_the_grid_by_float_error_still_reads_on_it() {
    let format = SignalValueFormat::of(&signal(Some(0.1), None, None));
    assert_eq!(format_value(0.1 + 0.2, format.sample), "0.3");
    assert_eq!(format_value(0.3 - 0.1, format.sample), "0.2");
}

#[test]
fn a_mean_without_a_precision_reads_one_place_finer_than_the_signals_grid() {
    let whole = SignalValueFormat::of(&signal(None, None, None));
    assert_eq!(whole.mean, ValueFormat { places: 1, padded: false });
    assert_eq!(format_value(89.25, whole.mean), "89.3");
    assert_eq!(format_value(89.0, whole.mean), "89");
    assert_eq!(format_value(-0.04, whole.mean), "0");

    let tenths = SignalValueFormat::of(&signal(Some(0.1), None, None));
    assert_eq!(format_value(12.345, tenths.mean), "12.35");
}

#[test]
fn a_mean_with_a_precision_is_fixed_to_it() {
    let fixed = SignalValueFormat::of(&signal(Some(0.1), None, Some(2)));
    assert_eq!(fixed.mean, fixed.sample);
    assert_eq!(format_value(12.345, fixed.mean), "12.35");
    assert_eq!(format_value(12.0, fixed.mean), "12.00");
    assert_eq!(format_value(-0.001, fixed.mean), "0.00");
}

/// `formatAs` in the Dashboard reads these; `WRITE_DATA_FIXTURES=1` rewrites them.
#[test]
fn formatted_values_match_the_frontend_fixture() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures/data/dashboardValueFormat.json");
    let values = [89.0, 89.25, -89.25, 0.1 + 0.2, 1.0005, 9.995, 99.95, -0.004, 0.0, 12_345.678, 1e-7, 1e21];
    let cases: Vec<serde_json::Value> = values
        .iter()
        .flat_map(|&value| {
            [(0, false), (1, false), (2, false), (2, true), (3, true)].map(|(places, padded)| {
                let format = ValueFormat { places, padded };
                serde_json::json!({ "value": value, "format": format, "text": format_value(value, format) })
            })
        })
        .collect();
    let golden = serde_json::json!({ "cases": cases });
    if std::env::var_os("WRITE_DATA_FIXTURES").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&golden).unwrap() + "\n").unwrap();
    }
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).unwrap();
    assert_eq!(golden, fixture);
}
