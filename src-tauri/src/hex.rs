//! One reading of a hex byte string, for every field that takes one: a framing
//! delimiter, a vendor-code list, a CSV data cell, bytes handed in over MCP.

/// Bytes from a hex string. Tokens split on whitespace and commas, each with an
/// optional `0x`; a token is one byte (`5`, `0A`) or an even run of them
/// (`CAFEF00D`). Anything else fails, naming the token.
pub fn parse_bytes(text: &str) -> Result<Vec<u8>, String> {
    tokens(text)
        .map(token)
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.concat())
}

/// As [`parse_bytes`], dropping a token that is not bytes rather than failing —
/// for a hand-typed list, where one bad entry should not empty the field.
pub fn parse_bytes_lenient(text: &str) -> Vec<u8> {
    tokens(text)
        .filter_map(|t| token(t).ok())
        .flatten()
        .collect()
}

fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|t| !t.is_empty())
}

fn token(tok: &str) -> Result<Vec<u8>, String> {
    let hex = tok
        .strip_prefix("0x")
        .or_else(|| tok.strip_prefix("0X"))
        .unwrap_or(tok);
    let digits: Option<Vec<u8>> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect();
    match digits.as_deref() {
        Some([d]) => Ok(vec![*d]),
        Some(d) if !d.is_empty() && d.len() % 2 == 0 => {
            Ok(d.chunks(2).map(|p| (p[0] << 4) | p[1]).collect())
        }
        _ => Err(format!("`{tok}` is not hex bytes")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spelling_of_the_same_bytes_agrees() {
        let want = Ok(vec![0x01, 0x04, 0x4D, 0xE2]);
        assert_eq!(parse_bytes("01 04 4D E2"), want);
        assert_eq!(parse_bytes("01044de2"), want);
        assert_eq!(parse_bytes("0x01,0x04, 0x4d\t0xE2"), want);
        assert_eq!(parse_bytes("0x0104 4DE2"), want);
    }

    /// The MCP tool used to strip non-hex characters first, so `0x01 0x04` left
    /// a stray `0` per token and ingested as `00 10 04`.
    #[test]
    fn a_prefix_is_a_prefix_not_a_digit() {
        assert_eq!(parse_bytes("0x01 0x04"), Ok(vec![0x01, 0x04]));
    }

    #[test]
    fn a_single_digit_is_one_byte() {
        assert_eq!(parse_bytes("5, A"), Ok(vec![0x05, 0x0A]));
    }

    #[test]
    fn what_is_refused() {
        assert!(parse_bytes("0D0").is_err(), "odd run");
        assert!(parse_bytes("0x").is_err(), "prefix alone");
        assert!(parse_bytes("zz").is_err());
        assert!(parse_bytes("éé").is_err(), "non-ASCII must not panic");
        assert_eq!(parse_bytes(""), Ok(Vec::new()));
    }

    #[test]
    fn lenient_drops_a_bad_token_whole() {
        assert_eq!(parse_bytes_lenient("20 6g 65 0x"), vec![0x20, 0x65]);
        assert_eq!(parse_bytes_lenient("CAFEF00"), Vec::<u8>::new());
    }
}
