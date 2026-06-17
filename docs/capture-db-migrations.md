# Capture database schema migrations

**Any change to the `buffers.db` schema MUST be a recorded migration.** Never
issue ad-hoc DDL (`CREATE TABLE`, `ALTER TABLE`, …) from feature code — not
even "idempotent" `IF NOT EXISTS` statements. Recorded migrations run exactly
once from a known starting shape; ad-hoc DDL and shape-inference cannot make
that guarantee once databases from different builds mix.

The runner is `run_migrations` + `MIGRATIONS` in
[src-tauri/src/capture_db.rs](../src-tauri/src/capture_db.rs); schema
reference in [capture-database-schema.md](capture-database-schema.md).

## How it works

- `PRAGMA user_version` is the authoritative schema version; 0 means
  unstamped (any pre-versioning shape).
- The `schema_migrations` table is the audit trail: one row per applied
  migration (`version`, `name`, `applied_at` epoch seconds).
- Each migration applies inside its own transaction together with its audit
  row and version stamp — a crash can never leave a step half-applied or
  applied-but-unrecorded.

## Adding a migration

1. Create `src-tauri/migrations/NNNN_short_name.sql`, where `NNNN` is the
   next version, zero-padded (`0002_add_capture_notes.sql`). Plain SQL only;
   it is applied verbatim in one transaction.
2. Append an entry to `MIGRATIONS` in `capture_db.rs`:
   `MigrationStep::Sql(include_str!("../migrations/NNNN_short_name.sql"))`.
3. Add a test in `capture_db.rs` exercising the new step.
4. Update [capture-database-schema.md](capture-database-schema.md) to match.

## Rules

- **Never edit or renumber a shipped migration.** Fix mistakes with a new
  migration.
- **Never write a migration that infers state from the schema shape.** The
  v1 baseline (`baseline_capture_schema`, Rust) is the sole exception — it
  normalises unstamped pre-versioning databases of unknown shape. Every
  migration after it starts from a known, stamped shape.
- `MigrationStep::Rust` is for conditional logic SQL cannot express; prefer
  SQL files so the change is reviewable as plain text.
