// crates/wiretap-app/src/report/locale.rs
//
// The reports' words: i18next templates keyed `namespace:dotted.key`, from the
// frontend's table for the user's language, else the embedded en-AU locale.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::Value;

/// The reports' words and number style in the user's language, supplied by the frontend.
#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReportLocale {
    /// Templates by `namespace:dotted.key`; a key left out reads in English.
    messages: HashMap<String, String>,
    group_separator: String,
    decimal_separator: String,
}

type Table = HashMap<String, String>;

const EN_AU: [(&str, &str); 2] = [
    ("reports", include_str!("../../../../frontend/wiretap-ui/src/locales/en-AU/reports.json")),
    ("discovery", include_str!("../../../../frontend/wiretap-ui/src/locales/en-AU/discovery.json")),
];

static ENGLISH: Lazy<Table> = Lazy::new(|| {
    let mut table = Table::new();
    for (namespace, json) in EN_AU {
        flatten(&mut table, &format!("{namespace}:"), &serde_json::from_str(json).expect("the en-AU locale parses"));
    }
    table
});

fn flatten(table: &mut Table, path: &str, value: &Value) {
    match value {
        Value::Object(map) => {
            let sep = if path.ends_with(':') { "" } else { "." };
            for (key, value) in map {
                flatten(table, &format!("{path}{sep}{key}"), value);
            }
        }
        Value::String(text) => {
            table.insert(path.to_string(), text.clone());
        }
        _ => {}
    }
}

/// `key_one` for one where the table has it, else `key_other`, else `key`.
fn plural<'a>(table: &'a Table, key: &str, n: usize) -> Option<&'a str> {
    let one = (n == 1).then(|| format!("{key}_one"));
    one.into_iter()
        .chain([format!("{key}_other"), key.to_string()])
        .find_map(|k| table.get(&k))
        .map(String::as_str)
}

fn interpolate(template: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open..].find("}}").map(|c| open + c) else { break };
        out += &rest[..open];
        let name = rest[open + 2..close].trim();
        match params.iter().find(|(n, _)| *n == name) {
            Some((_, value)) => out += value,
            None => out += &rest[open..close + 2],
        }
        rest = &rest[close + 2..];
    }
    out + rest
}

impl Default for ReportLocale {
    fn default() -> Self {
        Self { messages: Table::new(), group_separator: ",".into(), decimal_separator: ".".into() }
    }
}

impl ReportLocale {
    pub fn t(&self, key: &str, params: &[(&str, &str)]) -> String {
        let template = self.messages.get(key).or_else(|| ENGLISH.get(key)).map_or(key, String::as_str);
        interpolate(template, params)
    }

    pub fn label(&self, key: &str) -> String {
        self.t(key, &[])
    }

    /// `n`, grouped, in the plural form of `key` that fits it.
    pub fn count(&self, key: &str, n: usize) -> String {
        let template = plural(&self.messages, key, n).or_else(|| plural(&ENGLISH, key, n)).unwrap_or(key);
        interpolate(template, &[("count", &self.grouped(n))])
    }

    pub fn grouped(&self, n: usize) -> String {
        let digits = n.to_string();
        let mut out = String::new();
        for (i, d) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out += &self.group_separator;
            }
            out.push(d);
        }
        out
    }

    /// A number Rust wrote with a `.` point, in the user's decimal style.
    pub fn decimal(&self, number: impl ToString) -> String {
        number.to_string().replace('.', &self.decimal_separator)
    }

    /// A duration to one decimal place, in seconds from a second up.
    pub fn ms(&self, value: f64) -> String {
        if (value * 10.0).round() >= 10_000.0 {
            self.t("reports:seconds", &[("value", &self.decimal(format!("{:.1}", value / 1000.0)))])
        } else {
            self.t("reports:milliseconds", &[("value", &self.decimal(format!("{value:.1}")))])
        }
    }

    pub fn optional_ms(&self, value: Option<f64>) -> String {
        value.map_or_else(|| "—".into(), |v| self.ms(v))
    }

    pub fn percent(&self, value: impl ToString) -> String {
        self.t("reports:percent", &[("value", &self.decimal(value))])
    }

    pub fn protocol_label(&self, protocol: &str) -> String {
        let key = match protocol {
            "can" => "reports:protocol.can",
            "canfd" => "reports:protocol.canfd",
            "modbus" => "reports:protocol.modbus",
            "modbus_rtu" => "reports:protocol.modbusRtu",
            "serial" => "reports:protocol.serial",
            other => return other.into(),
        };
        self.label(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn locale(messages: &[(&str, &str)], group: &str, decimal: &str) -> ReportLocale {
        ReportLocale {
            messages: messages.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            group_separator: group.into(),
            decimal_separator: decimal.into(),
        }
    }

    #[test]
    fn numbers_group_in_threes() {
        let l = ReportLocale::default();
        assert_eq!(l.grouped(0), "0");
        assert_eq!(l.grouped(999), "999");
        assert_eq!(l.grouped(1000), "1,000");
        assert_eq!(l.grouped(1_234_567), "1,234,567");
        assert_eq!(l.count("reports:count.frame", 1), "1 frame");
        assert_eq!(l.count("reports:count.frame", 2048), "2,048 frames");
        assert_eq!(l.count("reports:count.frame", 0), "0 frames");
    }

    #[test]
    fn numbers_take_the_supplied_separators() {
        let l = locale(&[], ".", ",");
        assert_eq!(l.grouped(1_234_567), "1.234.567");
        assert_eq!(l.ms(12.34), "12,3 ms");
        assert_eq!(l.ms(12_345.0), "12,3 s");
    }

    #[test]
    fn a_duration_that_rounds_to_a_second_reads_in_seconds() {
        let l = ReportLocale::default();
        assert_eq!(l.ms(999.94), "999.9 ms");
        assert_eq!(l.ms(999.95), "1.0 s");
        assert_eq!(l.ms(12_345.0), "12.3 s");
    }

    #[test]
    fn a_supplied_table_words_headings_and_notes() {
        let l = locale(
            &[
                ("reports:summary", "Zusammenfassung"),
                ("discovery:changes.note.varyingLength", "Variable Länge: {{min}} bis {{max}} Bytes"),
            ],
            ".",
            ",",
        );
        assert_eq!(l.label("reports:summary"), "Zusammenfassung");
        assert_eq!(
            l.t("discovery:changes.note.varyingLength", &[("min", "1"), ("max", "8")]),
            "Variable Länge: 1 bis 8 Bytes"
        );
    }

    #[test]
    fn a_key_the_table_lacks_reads_in_english() {
        let l = locale(&[("reports:summary", "Zusammenfassung")], ".", ",");
        assert_eq!(l.label("reports:footer"), "Generated by WireTAP");
        assert_eq!(l.count("reports:count.byte", 1), "1 byte");
    }

    #[test]
    fn plurals_pick_one_then_other_then_the_bare_key() {
        let zh = locale(&[("reports:count.frame_other", "{{count}} 帧")], ",", ".");
        assert_eq!(zh.count("reports:count.frame", 1), "1 帧");
        assert_eq!(zh.count("reports:count.frame", 3), "3 帧");
        let bare = locale(&[("reports:count.frame", "frames: {{count}}")], ",", ".");
        assert_eq!(bare.count("reports:count.frame", 2), "frames: 2");
    }

    #[test]
    fn interpolation_leaves_unknown_slots_and_does_not_reinterpolate_values() {
        assert_eq!(interpolate("{{a}} {{b}}", &[("a", "{{b}}")]), "{{b}} {{b}}");
        assert_eq!(interpolate("{{ a }}!", &[("a", "x")]), "x!");
        assert_eq!(interpolate("open {{", &[]), "open {{");
    }

    /// Every reports key literal in the report code, plural keys by their stem.
    fn keys_in_source() -> BTreeSet<String> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/report");
        let mut keys = BTreeSet::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let source = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            for literal in source.split("\"reports:").skip(1) {
                let key = literal.split('"').next().unwrap();
                if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
                    keys.insert(format!("reports:{key}"));
                }
            }
        }
        keys
    }

    #[test]
    fn every_key_the_reports_use_is_in_the_english_table() {
        let missing: Vec<String> =
            keys_in_source().into_iter().filter(|k| plural(&ENGLISH, k, 2).is_none()).collect();
        assert!(missing.is_empty(), "keys missing from reports.json: {missing:?}");
    }

    #[test]
    fn every_reports_string_is_used() {
        let used = keys_in_source();
        let unused: Vec<&String> = ENGLISH
            .keys()
            .filter(|k| k.starts_with("reports:"))
            .filter(|k| !used.contains(k.trim_end_matches("_one").trim_end_matches("_other")))
            .collect();
        assert!(unused.is_empty(), "unused reports.json keys: {unused:?}");
    }
}
