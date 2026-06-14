//! Capture-database schema bootstrap. The canonical schema lives in
//! tools/wiretap-server/init_schema.sql (shared with standalone
//! wiretap-server deployments) and is embedded at compile time.
//!
//! TimescaleDB continuous aggregates cannot be created inside a transaction
//! block, and the simple-protocol batch executor runs a multi-statement
//! string as one implicit transaction — so the file is split into individual
//! statements (dollar-quote aware) and executed one at a time.

use tokio_postgres::Client;

const INIT_SCHEMA: &str = include_str!("../../wiretap-server/init_schema.sql");

/// The grants in init_schema.sql target the `candor` ingest role; create it
/// (NOLOGIN) so a pristine container database accepts the schema unchanged.
const PREAMBLE: &str = r#"
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'candor') THEN
    CREATE ROLE candor NOLOGIN;
  END IF;
END $$;
"#;

/// Apply the full capture schema to an (empty or already-initialised)
/// database. Statements are idempotent (IF NOT EXISTS throughout).
pub async fn apply_capture_schema(client: &Client) -> Result<(), String> {
    client
        .batch_execute(PREAMBLE)
        .await
        .map_err(|e| format!("schema preamble failed: {e}"))?;
    for stmt in split_statements(INIT_SCHEMA) {
        client
            .batch_execute(&stmt)
            .await
            .map_err(|e| format!("schema statement failed: {e}\nstatement: {stmt}"))?;
    }
    Ok(())
}

/// Split an SQL script into statements on top-level semicolons, respecting
/// dollar-quoted bodies ($$ … $$ / $tag$ … $tag$), quoted strings and
/// line comments. Good enough for our own schema file; not a general parser.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = sql.char_indices().peekable();
    let bytes = sql.as_bytes();
    let mut dollar_tag: Option<String> = None;
    let mut in_single = false;
    let mut in_comment = false;

    while let Some((i, c)) = chars.next() {
        if in_comment {
            current.push(c);
            if c == '\n' {
                in_comment = false;
            }
            continue;
        }
        if let Some(tag) = &dollar_tag {
            current.push(c);
            if c == '$' && sql[i..].starts_with(tag.as_str()) {
                for _ in 0..tag.len() - 1 {
                    if let Some((_, c2)) = chars.next() {
                        current.push(c2);
                    }
                }
                dollar_tag = None;
            }
            continue;
        }
        if in_single {
            current.push(c);
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        match c {
            '-' if bytes.get(i + 1) == Some(&b'-') => {
                in_comment = true;
                current.push(c);
            }
            '\'' => {
                in_single = true;
                current.push(c);
            }
            '$' => {
                // Possible dollar-quote opener: $tag$ where tag is [A-Za-z0-9_]*
                let rest = &sql[i + 1..];
                if let Some(end) = rest.find('$') {
                    let tag_body = &rest[..end];
                    if tag_body.chars().all(|t| t.is_ascii_alphanumeric() || t == '_') {
                        let tag = format!("${tag_body}$");
                        current.push(c);
                        for _ in 0..tag.len() - 1 {
                            if let Some((_, c2)) = chars.next() {
                                current.push(c2);
                            }
                        }
                        dollar_tag = Some(tag);
                        continue;
                    }
                }
                current.push(c);
            }
            ';' => {
                let stmt = current.trim();
                if !stmt.is_empty() && !is_only_comments(stmt) {
                    out.push(stmt.to_string());
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }
    let stmt = current.trim();
    if !stmt.is_empty() && !is_only_comments(stmt) {
        out.push(stmt.to_string());
    }
    out
}

fn is_only_comments(stmt: &str) -> bool {
    stmt.lines().all(|l| {
        let l = l.trim();
        l.is_empty() || l.starts_with("--")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple_statements() {
        let stmts = split_statements("CREATE TABLE a (x int);\nCREATE TABLE b (y int);");
        assert_eq!(stmts.len(), 2);
        assert!(stmts[1].starts_with("CREATE TABLE b"));
    }

    #[test]
    fn keeps_dollar_quoted_bodies_intact() {
        let sql = "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\n\
                   BEGIN RAISE NOTICE 'a;b'; END $$;\nSELECT 1;";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("RAISE NOTICE 'a;b';"));
    }

    #[test]
    fn handles_tagged_dollar_quotes_and_comments() {
        let sql = "-- leading comment; with semicolon\n\
                   CREATE FUNCTION g() AS $fn$ SELECT 1; $fn$ LANGUAGE sql;\nSELECT 2;";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("$fn$ SELECT 1; $fn$"));
    }

    #[test]
    fn embedded_schema_splits_and_contains_expected_objects() {
        let stmts = split_statements(INIT_SCHEMA);
        assert!(stmts.iter().any(|s| s.contains("CREATE TABLE IF NOT EXISTS public.can_frame")));
        assert!(stmts.iter().any(|s| s.contains("create_hypertable")));
        assert!(stmts.iter().any(|s| s.contains("can_frame_hourly")));
        // The plpgsql function body must survive as a single statement
        let f = stmts
            .iter()
            .find(|s| s.contains("CREATE FUNCTION public.ingest_can_frame"))
            .expect("ingest function present");
        assert!(f.contains("INSERT INTO public.can_frame"));
        assert!(f.contains("END $$"));
    }
}
