#![cfg(feature = "ts")]
//! Every exported file imports each type it names from a file that exists, so the
//! desktop's `tsc` compiles what `export_all` writes.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::{Config, TS};

const BUILTINS: &[&str] = &["Array", "Record", "Partial"];

fn export_roots(dir: &Path) {
    let cfg = Config::new().with_large_int("number").with_out_dir(dir);
    macro_rules! export {
        ($($t:ty),* $(,)?) => { $(<$t>::export_all(&cfg).unwrap();)* };
    }
    export!(
        wslib_bits::register::RegisterView,
        wslib_bits::register::RegisterPairView,
        wslib_bits::groups::Group,
        wslib_bits::frame_id::MatchedRange,
        wslib_wiretap_catalogue::Catalogue,
        wslib_wiretap_catalogue::EffectiveDefaults,
        wslib_wiretap_catalogue::ValidationError,
        wslib_wiretap_catalogue::edit::EditOp,
        wslib_wiretap_catalogue::FrameLayout,
        wslib_wiretap_catalogue::DiffRow,
        wslib_wiretap_catalogue::FrameIdConfig,
        wslib_wiretap_catalogue::FramingMode,
        wslib_modbus::LengthRule,
        wslib_wiretap_catalogue::RtuSettings,
        wslib_modbus::Selector,
        wslib_wiretap_gateway::QuerySpec,
        wslib_wiretap_gateway::FirstLastQueryResult,
        wslib_wiretap_gateway::Protocol,
        wiretap_analysis::dashboard::HistogramBin,
        wiretap_analysis::draft::ExportMeta,
        wiretap_analysis::draft::ExportFrame,
        wiretap_analysis::draft::ModbusExportConfig,
        wiretap_analysis::draft::ModbusRegister,
        wiretap_analysis::source::InventoryRow,
        wiretap_analysis::source::OrderStart,
    );
}

fn strip_comments_and_strings(src: &str) -> String {
    let mut out = String::new();
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => _ = chars.next(),
                        '"' => break,
                        _ => {}
                    }
                }
                out.push_str("\"\"");
            }
            '/' if chars.peek() == Some(&'*') => {
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// The capitalised identifiers in type position: not object keys.
fn referenced_types(body: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let ident = &body[start..i];
            let rest = body[i..].trim_start();
            let is_key = rest.starts_with(':') || rest.starts_with("?:");
            if ident.starts_with(char::is_uppercase) && !is_key {
                found.insert(ident.to_string());
            }
        } else {
            i += 1;
        }
    }
    found
}

fn ts_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = vec![];
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(ts_files(&path));
        } else if path.extension().is_some_and(|e| e == "ts") {
            files.push(path);
        }
    }
    files
}

fn problems_in(file: &Path) -> Vec<String> {
    let raw = fs::read_to_string(file).unwrap();
    let mut known: BTreeSet<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    let mut problems = vec![];
    let mut body = String::new();
    for line in raw.lines() {
        let Some(rest) = line.strip_prefix("import type { ") else {
            continue;
        };
        let (name, from) = rest.split_once(" } from \"").unwrap();
        let target = file
            .parent()
            .unwrap()
            .join(format!("{}.ts", from.trim_end_matches(['"', ';'])));
        if !target.exists() {
            problems.push(format!("imports {name} from missing {}", target.display()));
        }
        known.insert(name.to_string());
    }
    for line in strip_comments_and_strings(&raw)
        .lines()
        .filter(|l| !l.starts_with("import "))
    {
        if let Some(decl) = line.strip_prefix("export type ") {
            let name: String = decl
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            known.insert(name);
        }
        body.push_str(line);
        body.push('\n');
    }
    for name in referenced_types(&body) {
        if !known.contains(&name) {
            problems.push(format!("uses {name} without importing it"));
        }
    }
    problems
}

#[test]
fn every_exported_type_is_declared_or_imported() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ts_imports");
    _ = fs::remove_dir_all(&dir);
    export_roots(&dir);

    let files = ts_files(&dir);
    assert!(files.iter().any(|f| f.ends_with("SignalFields.ts")));
    let problems: Vec<String> = files
        .iter()
        .flat_map(|f| {
            problems_in(f)
                .into_iter()
                .map(move |p| format!("{}: {p}", f.file_name().unwrap().to_string_lossy()))
        })
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}
