//! Scanning a catalogue for credentials before it is published.
//!
//! Reverse-engineering notes carry real secrets: VINs, serial numbers, MQTT
//! passwords, customer names. A published secret is public permanently — it must be
//! **rotated**, not force-pushed away — so this gates the publish behind an explicit
//! acknowledgement rather than a warning.
//!
//! Shape matching rather than regex, to avoid the dependency. False positives are
//! acceptable in principle because the user can acknowledge them — but only just:
//! a scanner that cries wolf is one people learn to click straight through, which is
//! why the credential rule insists the keyword appear in the assignment *key*.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    pub line: usize,
    pub label: String,
    /// The matched line, truncated — enough to recognise, not enough to leak.
    pub excerpt: String,
}

/// One detector: a label and a predicate over a single line.
type Rule = (&'static str, fn(&str) -> bool);

/// First match wins, so order matters: the specific token shapes come before the
/// generic `key = "value"` rule, which would otherwise swallow them.
const RULES: &[Rule] = &[
    ("GitHub token", |l| {
        ["ghp_", "github_pat_", "gho_", "ghs_"]
            .iter()
            .any(|p| l.contains(p))
    }),
    // `-----BEGIN` first so the lowercase allocation only happens on a candidate.
    ("Private key", |l| {
        l.contains("-----BEGIN") && l.to_lowercase().contains("private key")
    }),
    ("AWS access key", |l| {
        l.contains("AKIA") && has_run_of(l, 16, |c| c.is_ascii_uppercase() || c.is_ascii_digit())
    }),
    ("Slack token", |l| {
        ["xoxb-", "xoxp-", "xoxa-", "xoxs-"]
            .iter()
            .any(|p| l.contains(p))
    }),
    ("API key", |l| {
        l.contains("sk-") && has_run_of(l, 20, |c| c.is_ascii_alphanumeric())
    }),
    ("JSON web token", |l| {
        l.contains("eyJ")
            && has_run_of(l, 20, |c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }),
    ("Credential", |l| looks_like_credential_assignment(l)),
    ("URL with credentials", |l| has_userinfo_url(l)),
    ("Possible VIN", |l| looks_like_vin(l)),
];

/// Lines that look like they carry a credential.
pub fn scan(content: &str) -> Vec<SecretFinding> {
    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            RULES
                .iter()
                .find(|(_, matches)| matches(line))
                .map(|(label, _)| SecretFinding {
                    line: index + 1,
                    label: label.to_string(),
                    excerpt: truncate(line.trim(), 80),
                })
        })
        .collect()
}

/// `key = "value"` where the **key** names a credential and the value is substantial.
///
/// The keyword must appear in the key, not anywhere on the line: a catalogue may
/// legitimately have `notes = "token frame"` or a signal called `Secret_Counter`.
fn looks_like_credential_assignment(line: &str) -> bool {
    const KEYS: &[&str] = &[
        "password", "passwd", "secret", "api_key", "apikey", "api-key", "token",
    ];
    let Some((key, value)) = line.split_once('=') else {
        return false;
    };
    let key = key.trim().to_lowercase();
    // A commented-out assignment is not a live secret.
    if key.starts_with('#') || !KEYS.iter().any(|k| key.contains(k)) {
        return false;
    }
    value.trim().trim_matches(|c| c == '"' || c == '\'').len() >= 6
}

/// A URL carrying `user:pass@host`.
fn has_userinfo_url(line: &str) -> bool {
    line.split("://").skip(1).any(|rest| {
        let authority = rest.split(['/', ' ', '"']).next().unwrap_or("");
        authority.contains(':') && authority.contains('@')
    })
}

/// A 17-character VIN: alphanumeric excluding I, O and Q.
fn looks_like_vin(line: &str) -> bool {
    line.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| {
        word.len() == 17
            && word.chars().all(|c| {
                c.is_ascii_digit() || (c.is_ascii_uppercase() && !matches!(c, 'I' | 'O' | 'Q'))
            })
            && word.chars().any(|c| c.is_ascii_digit())
            && word.chars().any(|c| c.is_ascii_alphabetic())
    })
}

fn has_run_of(line: &str, len: usize, allowed: impl Fn(char) -> bool) -> bool {
    let mut run = 0;
    for c in line.chars() {
        run = if allowed(c) { run + 1 } else { 0 };
        if run >= len {
            return true;
        }
    }
    false
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(content: &str) -> Vec<String> {
        scan(content).into_iter().map(|f| f.label).collect()
    }

    #[test]
    fn finds_github_tokens_and_private_keys() {
        let findings = scan("# notes\ntoken = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"\n[meta]\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].line, 2);
        assert_eq!(findings[0].label, "GitHub token");

        assert_eq!(labels("-----BEGIN RSA PRIVATE KEY-----\n"), ["Private key"]);
    }

    #[test]
    fn finds_credential_assignments_and_urls() {
        assert_eq!(labels("password = \"hunter2000\"\n"), ["Credential"]);
        assert_eq!(
            labels("# broker at mqtt://user:s3cretpw@host:1883\n"),
            ["URL with credentials"]
        );
    }

    #[test]
    fn finds_aws_keys_slack_and_jwts() {
        assert_eq!(labels("key = AKIAIOSFODNN7EXAMPLE\n"), ["AWS access key"]);
        assert_eq!(labels("hook = xoxb-1234-5678-abcdefg\n"), ["Slack token"]);
        assert_eq!(
            labels("jwt = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc\n"),
            ["JSON web token"]
        );
    }

    #[test]
    fn finds_a_vin() {
        assert_eq!(labels("# vehicle 1HGBH41JXMN109186 under test\n"), ["Possible VIN"]);
    }

    /// A normal catalogue must not trip the scanner, or the confirm step becomes
    /// noise the user learns to click through.
    #[test]
    fn a_normal_catalogue_is_clean() {
        let toml = r#"
# Sungrow SBR battery, reverse-engineered from CAN traffic.
[meta]
name = "SBRXXX"
version = 8

[meta.can]
default_byte_order = "little"

[frame.can."0x100"]
length = 8
notes = "Cell voltages, 16-bit big-endian, scale 0.001"

[[frame.can."0x100".signals]]
name = "Cell_Voltage_1"
start_bit = 0
bit_length = 16
scale = 0.001
unit = "V"
"#;
        assert_eq!(scan(toml), vec![], "should be no findings");
    }

    #[test]
    fn empty_or_commented_credentials_are_not_findings() {
        assert!(scan("token = \"\"\n").is_empty());
        assert!(scan("# the password is stored elsewhere\n").is_empty());
        assert!(scan("# password = \"hunter2000\"\n").is_empty());
    }

    /// The keyword has to be in the key. Catalogues legitimately talk about tokens
    /// and secrets in signal names and notes, and a scanner that flags those is one
    /// users learn to click through — which defeats the whole point.
    #[test]
    fn credential_words_in_values_and_names_are_not_findings() {
        for line in [
            "notes = \"token frame\"\n",
            "name = \"Secret_Counter\"\n",
            "notes = \"password-protected diagnostic session\"\n",
            "name = \"Token_Passing_Status\"\n",
        ] {
            assert!(scan(line).is_empty(), "should not flag: {line:?}");
        }
    }

    #[test]
    fn excerpts_are_truncated() {
        let findings = scan(&format!("password = \"{}\"", "x".repeat(200)));
        assert_eq!(findings.len(), 1);
        assert!(findings[0].excerpt.chars().count() <= 81);
        assert!(findings[0].excerpt.ends_with('…'));
    }

    /// First match wins, and the specific shapes must beat the generic rule.
    #[test]
    fn specific_token_shapes_win_over_the_generic_rule() {
        assert_eq!(
            labels("token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"\n"),
            ["GitHub token"],
            "should not be reported as a generic Credential"
        );
    }
}
