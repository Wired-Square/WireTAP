# wiretap-capture-store

WireTAP's capture store in one SQLite file: captures, each a run of frames or of raw
serial bytes, with their metadata and events.

**Not pure Rust.** `migrations/` ships the schema's migration chain as SQL,
and `legacy/` the frozen steps for files written before it.

```rust
use wiretap_capture_store::{Cancel, Store};

let (store, applied) = Store::open(data_dir.join("captures.db")).await?;
store.insert_frames(&capture_id, &batch).await?;
let (frames, rowids) = store.get_frames_tail_rows(&capture_id, 200).await?;
let rows = store.read_rows(&statement, &cancel, |row| row.try_get::<i64, _>(0)).await?;
```

## What's here

`Store`, `chain()`, `tuning()`, `upgrade_legacy`, `Cancel` and
`inventory_row`, on sqlx and `wslib-db-sqlite`, the row, filter and event
types, and `inventory_statement`.

- **`Store`**, over a `wslib_db_sqlite::Database`: frames (`insert_frames`,
  `clear_and_refill`, paged, filtered by a `FrameSelection`, tail, chunks by
  rowid, by index and by time, counts, `get_frame_info`, `get_latest_frames`),
  `search_frames`, bytes, metadata, events, `frame_inventory`, `payloads`
  (one frame's newest run or a spread, by `PayloadQuery`), `read_rows`, the
  plain `rows`, and whole captures (`copy_capture_data`, `delete_capture_data`,
  `sweep_non_persistent`). An insert is one transaction per batch, in order;
  a whole-capture operation commits a window of 5,000 rowids at a time, so
  a reader sees it part-way and one cut short is finished by running it
  again.
- Every write goes through the database's one writer connection, so writers
  queue in turn and readers can't hold one up for a connection.
- **`StoredFrame`**, one `frames` row with its protocol an open string, and
  **`FrameRecord`**, what an insert reads, borrowed, so an application's own
  frame type goes in without a copy.
- **`Sql`**, **`FrameRowFilter`** and **`CaptureProtocol`**: a `WHERE`
  clause over `frames`, and the statements built on it; `sql_where_named`
  takes a stored protocol name `CaptureProtocol` doesn't list. `inventory_statement`
  and `inventory_row` are the inventory's.
- **`Cancel`**: set it and a `read_rows` statement stops between SQLite VM
  steps with `CaptureError::Cancelled`. Dropping the read stops its statement
  too, and closes its connection rather than return the handler to the pool.
  The statement runs under `PRAGMA query_only`.
- `CaptureError`'s text is SQLite's own message; its source is the sqlx error.
- A connection goes back to the pool on the caller's runtime, so a sync caller
  that blocks that runtime while it waits can starve the pool, and dropping a
  `Store` or one of its futures outside a Tokio runtime panics in sqlx.
- `CaptureEvent`, `NewCaptureEvent` and `CaptureEventPatch`, a capture's
  annotations.

The off-by-default `ts` feature derives `ts_rs::TS` (ts-rs 12); the event
types export as `Event`, `NewEvent` and `EventPatch`.

## The file

`chain()` is the schema as a `wslib_db_sqlite::Chain` named `capture`.
`Store::open` runs `upgrade_legacy` on the file, then opens it with the chain,
and returns the legacy steps that ran for the application to log;
an application that keeps captures in its own database runs `upgrade_legacy`
on any file an older build may have written, adds `chain()` to its own, and
uses `Store::from_database`.

- `Store::open` stamps `user_version` as the chain's version plus 5 (6 for
  0001) in the chain's transaction, so a build on the older ladder opens the
  file, and refuses a file stamped newer (`NewerFile`). `chain()` itself
  leaves `user_version` alone, so a host database keeps its own.
- `upgrade_legacy` takes a file with `frames` or `buffer_metadata` and no
  `_capture_migrations` through the frozen ladder, versions 1 to 6, each step
  in one transaction with its `schema_migrations` row, and leaves any other
  file alone.
- `Store::open_copy(original, working)` copies a file the application did not
  create, with its `-wal`, and opens the copy: the original is never migrated.
- `sweep_non_persistent` vacuums and then truncates the WAL, so the file
  shrinks.
- Opening sets WAL, `synchronous = NORMAL` and owner-only permissions through
  `wslib-db-sqlite`, and `tuning()` a 10 MiB page cache (about 64 MiB across
  the six connections), in-memory temporaries and a 16 MiB `-wal` limit on
  each connection; an application opening its own database
  passes `tuning()` to `Database::open_with`.
