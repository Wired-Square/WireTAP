//! Generates `tests/fixtures/byte_roles/cases.json`, the synthetic input the desktop
//! runs its TypeScript classifier over to produce `expected.json`.
//!
//! Regenerate with `cargo test -p wiretap-analysis --test byte_roles_fixture -- --ignored`.
//! Changing a case changes the golden answers, so the desktop has to rerun its dump.

use std::fmt::Write;
use std::path::PathBuf;

/// Leading byte that is constant, non-printable and not a mux selector, so byte 1
/// is the column a role case is about.
const LEAD: u8 = 0xC0;

struct Case {
    name: &'static str,
    kind: &'static str,
    payloads: Vec<Vec<u8>>,
}

fn can(name: &'static str, payloads: Vec<Vec<u8>>) -> Case {
    Case {
        name,
        kind: "can",
        payloads,
    }
}

fn serial(name: &'static str, payloads: Vec<Vec<u8>>) -> Case {
    Case {
        name,
        kind: "serial",
        payloads,
    }
}

/// xorshift32: deterministic across platforms and needs no dependency.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }

    fn range(&mut self, lo: u32, hi: u32) -> u32 {
        lo + self.below(hi - lo + 1)
    }
}

fn column(values: impl IntoIterator<Item = u8>) -> Vec<Vec<u8>> {
    values.into_iter().map(|v| vec![LEAD, v]).collect()
}

fn looping(modulo: u8, samples: usize) -> Vec<Vec<u8>> {
    column((0..samples).map(|i| (i % modulo as usize) as u8))
}

fn walk(seed: u32, start: i32, samples: usize, step: impl Fn(&mut Rng) -> i32) -> Vec<u8> {
    let mut rng = Rng(seed);
    let mut value = start;
    (0..samples)
        .map(|_| {
            let current = value as u8;
            value = (value + step(&mut rng)).clamp(0, 255);
            current
        })
        .collect()
}

/// Up three, down six, up three: half the moving transitions each way.
fn triangle(samples: usize) -> Vec<u8> {
    const WAVE: [i32; 12] = [0, 4, 8, 12, 8, 4, 0, -4, -8, -12, -8, -4];
    (0..samples).map(|i| (100 + WAVE[i % 12]) as u8).collect()
}

fn held(values: &[u8], hold: usize) -> Vec<u8> {
    values
        .iter()
        .flat_map(|&v| std::iter::repeat_n(v, hold))
        .collect()
}

fn word16(seed: u32, start: u32, samples: usize, lo: u32, hi: u32) -> Vec<u16> {
    let mut rng = Rng(seed);
    let mut value = start;
    (0..samples)
        .map(|_| {
            let current = value as u16;
            value += rng.range(lo, hi);
            current
        })
        .collect()
}

/// Steps of 12–20 never land a low byte from 250+ onto 0–5, so the pair below
/// the upper word never reads as a 16-bit sensor on its own.
fn sensor32_le(seed: u32, start: u32, samples: usize) -> Vec<Vec<u8>> {
    let mut rng = Rng(seed);
    let mut value = start;
    (0..samples)
        .map(|_| {
            let mut payload = vec![LEAD];
            payload.extend(value.to_le_bytes());
            value = value.wrapping_add(rng.range(12, 20));
            payload
        })
        .collect()
}

fn text() -> Vec<Vec<u8>> {
    (0..20u8)
        .map(|i| {
            let mut payload = vec![LEAD];
            payload.extend(format!("T={:02}C", 20 + i % 7).bytes());
            payload.push(i);
            payload
        })
        .collect()
}

fn varying_lengths() -> Vec<Vec<u8>> {
    (0..30u8)
        .map(|i| {
            let len = 4 + (i % 5) as usize;
            let mut payload = vec![LEAD, i, 0x55, i.wrapping_mul(2)];
            payload.extend((4..len).map(|j| 0xA0 + j as u8));
            payload
        })
        .collect()
}

fn runt_in_middle() -> Vec<Vec<u8>> {
    (0..20u8)
        .map(|i| {
            if i == 10 {
                vec![LEAD]
            } else {
                vec![LEAD, i, 0x10 + 3 * i]
            }
        })
        .collect()
}

fn mux_one_byte() -> Vec<Vec<u8>> {
    (0..48u8)
        .map(|i| {
            let case = i % 4;
            let occurrence = i / 4;
            vec![case, 0x11 * case, occurrence, 0x80 + case, 0, 0, 0, 0]
        })
        .collect()
}

fn mux_two_byte() -> Vec<Vec<u8>> {
    (0..45u8)
        .map(|i| {
            let (b0, b1) = (1 + (i / 3) % 3, 1 + i % 3);
            vec![b0, b1, i / 9, 0xAA]
        })
        .collect()
}

fn mux_sparse() -> Vec<Vec<u8>> {
    (0..20u8).map(|i| vec![(i % 2) * 10, i, 0x33]).collect()
}

fn mux_unbalanced() -> Vec<Vec<u8>> {
    (0..24u8)
        .map(|i| {
            let selector = match i {
                0 => 0,
                1 => 1,
                _ => 2,
            };
            vec![selector, i, 0x33]
        })
        .collect()
}

/// TWC-like: marker and type, a two-byte source address, data, then a
/// sum-of-bytes checksum.
fn twc(sources: &[[u8; 2]], seed: u32) -> Vec<Vec<u8>> {
    const MARKERS: [(u8, u8); 3] = [(0xFB, 0xE0), (0xFC, 0xE1), (0xFD, 0xE2)];
    let mut rng = Rng(seed);
    (0..60usize)
        .map(|i| {
            let (marker, kind) = MARKERS[i % 3];
            let source = sources[(i / 3) % sources.len()];
            let mut frame = vec![marker, kind, source[0], source[1]];
            frame.extend((0..8).map(|_| rng.below(256) as u8));
            let sum = frame[1..].iter().fold(0u8, |a, b| a.wrapping_add(*b));
            frame.push(sum);
            frame
        })
        .collect()
}

fn type_subtype() -> Vec<Vec<u8>> {
    let mut rng = Rng(0x7157);
    (0..60u8)
        .map(|i| {
            let mut frame = vec![0x10 + i % 2, (i / 2) % 10];
            frame.extend((0..6).map(|_| rng.below(256) as u8));
            frame
        })
        .collect()
}

fn wide_source() -> Vec<Vec<u8>> {
    let mut rng = Rng(0x0515);
    (0..60u8)
        .map(|i| {
            let source = 0x0101 + (i % 4) as u16;
            let mut frame = vec![1 + i % 5];
            frame.extend(source.to_be_bytes());
            frame.extend((0..5).map(|_| rng.below(256) as u8));
            frame
        })
        .collect()
}

fn cases() -> Vec<Case> {
    let le16 = |values: Vec<u16>| -> Vec<Vec<u8>> {
        values
            .into_iter()
            .map(|v| [&[LEAD][..], &v.to_le_bytes()].concat())
            .collect()
    };
    let be16 = |values: Vec<u16>| -> Vec<Vec<u8>> {
        values
            .into_iter()
            .map(|v| [&[LEAD][..], &v.to_be_bytes()].concat())
            .collect()
    };

    vec![
        can("static", (0..20u8).map(|i| vec![LEAD, 0x7F, i]).collect()),
        can("counter_up_1", column((0..30u8).map(|i| 10 + i))),
        can("counter_down_3", column((0..30u8).map(|i| 200 - 3 * i))),
        can(
            "counter_rolling_250_to_5",
            column((0..20u8).map(|i| 250u8.wrapping_add(i))),
        ),
        can(
            "counter_step_150",
            column((0..40u8).map(|i| i.wrapping_mul(150))),
        ),
        can("looping_mod10_under_50", looping(10, 30)),
        can("looping_mod10_over_50", looping(10, 60)),
        can("looping_mod16_under_50", looping(16, 40)),
        can("looping_mod16_over_50", looping(16, 64)),
        can(
            "sensor_increasing_variable_step",
            column(walk(0x5E45, 20, 60, |r| r.range(0, 4) as i32)),
        ),
        can(
            "sensor_decreasing",
            column(walk(0xDEC5, 230, 60, |r| -(r.range(0, 4) as i32))),
        ),
        can("sensor_mixed", column(triangle(60))),
        can(
            "flag_two_values",
            column((0..40u8).map(|i| u8::from((10..15).contains(&i) || (30..33).contains(&i)))),
        ),
        can("value_held_random", {
            let mut rng = Rng(0x7A1F);
            let levels: Vec<u8> = (0..34).map(|_| rng.below(256) as u8).collect();
            column(held(&levels, 3).into_iter().take(100))
        }),
        can(
            "unknown_three_values",
            column(held(&[10, 30, 20, 10, 20, 30, 10, 30, 20, 10], 10)),
        ),
        can("counter16_le", le16((0..40).map(|i| 0x12F0 + i).collect())),
        can(
            "counter16_be",
            be16((0..60).map(|i| 0x0100 + 97 * i).collect()),
        ),
        can("sensor16_le", le16(word16(0x516E, 0x03F0, 80, 1, 4))),
        can("sensor16_be", be16(word16(0x516B, 0x03F0, 80, 1, 4))),
        can("sensor32_le", sensor32_le(0x5E32, 0x0001_F000, 2400)),
        can(
            "sensor32_le_high_word_over_8000",
            sensor32_le(0x8032, 0x8001_F000, 2400),
        ),
        can("text", text()),
        can("identical", vec![vec![0x01, 0x02, 0x03, 0x04]; 10]),
        can("varying_lengths", varying_lengths()),
        can("runt_in_middle", runt_in_middle()),
        can("mux_one_byte", mux_one_byte()),
        can("mux_two_byte", mux_two_byte()),
        can("mux_rejected_sparse", mux_sparse()),
        can("mux_rejected_unbalanced", mux_unbalanced()),
        can("empty", vec![]),
        can("one_sample", vec![vec![LEAD, 0x01, 0x02]]),
        can(
            "two_samples",
            vec![vec![LEAD, 0x01, 0x02], vec![LEAD, 0x02, 0x02]],
        ),
        serial("twc_sources_1", twc(&[[0x77, 0x77]], 0x7C01)),
        serial("twc_sources_2", twc(&[[0x77, 0x77], [0x8C, 0x1E]], 0x7C02)),
        serial(
            "twc_sources_3",
            twc(&[[0x77, 0x77], [0x8C, 0x1E], [0x2A, 0x4B]], 0x7C03),
        ),
        serial(
            "twc_sources_4",
            twc(
                &[[0x77, 0x77], [0x8C, 0x1E], [0x2A, 0x4B], [0x05, 0x19]],
                0x7C04,
            ),
        ),
        serial("type_subtype", type_subtype()),
        serial("two_byte_source_over_ff", wide_source()),
    ]
}

fn render(cases: &[Case]) -> String {
    let mut out = String::from("[\n");
    for (i, case) in cases.iter().enumerate() {
        let payloads: Vec<String> = case
            .payloads
            .iter()
            .map(|p| {
                let bytes: Vec<String> = p.iter().map(u8::to_string).collect();
                format!("[{}]", bytes.join(","))
            })
            .collect();
        let body = if payloads.is_empty() {
            String::new()
        } else {
            format!("\n    {}\n  ", payloads.join(",\n    "))
        };
        let separator = if i + 1 < cases.len() { "," } else { "" };
        writeln!(
            out,
            "  {{ \"name\": \"{}\", \"kind\": \"{}\", \"payloads\": [{body}] }}{separator}",
            case.name, case.kind
        )
        .unwrap();
    }
    out.push_str("]\n");
    out
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/byte_roles/cases.json")
}

#[test]
#[ignore = "writes the fixture; run on purpose"]
fn write_cases_json() {
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, render(&cases())).unwrap();
}

#[test]
fn cases_json_matches_its_generator() {
    let on_disk = std::fs::read_to_string(fixture_path()).unwrap();
    assert!(
        on_disk == render(&cases()),
        "cases.json is stale: rerun the ignored write_cases_json"
    );
}

#[test]
fn case_names_are_unique() {
    let cases = cases();
    let mut names: Vec<_> = cases.iter().map(|c| c.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), cases.len());
}
