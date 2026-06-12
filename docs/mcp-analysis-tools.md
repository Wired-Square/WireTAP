# MCP analysis tools (headless capture / database analysis)

WireTAP's embedded MCP server (`src-tauri/src/mcp/`) exposes read tools that let an
agent inspect recorded CAN data **without any view open**. Alongside the existing
session/capture/catalog tools, these *analysis levers* run the same query engines
that back the Query app, against **either** a SQLite capture **or** a PostgreSQL
profile, and a catalog-coverage diff on top.

Implementation: [src-tauri/src/analysis.rs](../src-tauri/src/analysis.rs)
(orchestration + the pure byte-role classifier), the postgres/sqlite query backends in
[src-tauri/src/dbquery.rs](../src-tauri/src/dbquery.rs) and
[src-tauri/src/capture_db.rs](../src-tauri/src/capture_db.rs), wired as MCP tools in
[src-tauri/src/mcp/tools.rs](../src-tauri/src/mcp/tools.rs).

## Source addressing

Every analysis tool takes **exactly one** of:

- `capture_id` — a SQLite capture (from `list_captures`), or
- `profile_id` — a PostgreSQL profile (from `list_io_profiles`).

Postgres time bounds are RFC3339 strings (`start_time` / `end_time`); for captures
they are converted to the capture's microsecond timeline automatically.

These are **headless** — unlike `get_decoded_signals` / `get_discovery_analysis` /
`get_live_frame_map` (which bridge to an open Decoder/Discovery view), they read the
data store directly, so no window need be open.

## Tools

### `frame_inventory`
Per-frame-id rollup: `count`, `first_us` / `last_us`, `max_dlc`, `is_extended`, with
a `frame_id_hex`. The "what frame ids exist and how often" lever. Optional time
bounds. **On a large archive this is a full-table GROUP BY — pass `start_time` /
`end_time` to scope it.**

### `frame_byte_profile`
For one `frame_id`, classifies each payload byte over sampled frames:
`distinct`, `min`, `max`, `changes`, and a `role` of:

- `static` — never changes,
- `counter` — one dominant fixed step (≥80 % of transitions),
- `sensor` — otherwise varying.

This is the headless Rust equivalent of the frontend Discovery byte analysis
(`compute_byte_profile`). `sample_limit` (default 5000) bounds the work; the **most
recent** N frames are sampled (current behaviour, not the stale start of the archive).

### `catalog_coverage`
Parses a `catalog` (filename or display name) and diffs it against the source:

- `present` — catalog frames seen in the data (count, first/last, and each signal's
  confidence tier),
- `missing` — catalog frames absent from the data,
- `uncatalogued` — data frame ids not in the catalog (with counts),
- `confidence` — a `{ high, medium, low, unset }` rollup over directly-defined
  catalog signals (mirror/copy-inherited duplicates are excluded so each definition
  counts once).

`include_byte_roles` (default **false**) additionally samples per-byte roles for each
present frame — one sampling query per frame, so it's heavy on a big DB; enable it
deliberately. `sample_limit` (default 2000) bounds that sampling.

### Exposed query engines
The Query app's analytical engines, dispatched to postgres or capture by source:
`query_byte_changes`, `query_frame_changes`, `query_distribution`,
`query_gap_analysis`, `query_frequency`, `query_first_last`, `query_mux_statistics`.
Params and result shapes match the Query app (see
[capture-database-schema.md](capture-database-schema.md) for the underlying tables).

## Writing catalogs

Three tools let an agent persist decode work, gated by **two catalog-specific
permissions** (Settings → MCP), both off by default and independent of the control
gate:

- **`validate_catalog { content }`** — always available (read-only): parses + validates
  the TOML and returns `{ valid, errors: [{field, message}] }`. A dry run for the two
  writers.
- **`create_catalog { filename, content }`** — gated by **catalog write**. Creates a
  *new* file under the decoder directory; **refuses if it already exists**.
- **`update_catalog { filename, content }`** — gated by **catalog modify**. Overwrites
  an *existing* catalog (by filename or display name); **refuses if it doesn't exist**.

Both writers **validate before writing** and reject (without touching disk) if there
are any findings — so a malformed catalog can never be persisted. They take the full
TOML (the agent builds it; the tool validates + saves via `catalog::save_catalog`),
preserving comments, mux shorthands and mirror/copy inheritance. Filenames are
sanitised (no path separators or `..`; a `.toml` suffix is added if missing) and always
resolve under `settings.decoder_dir`.

The split lets a user grant *creating new* catalogues without granting *overwriting
existing* ones (or vice-versa). With neither granted, only `validate_catalog` is
exposed. Changing either toggle restarts the server so the gate takes effect.

## Scale note

The reference dataset is ~12 months of CAN dumps (individual frame ids exceed 10⁸
rows). `frame_inventory` and the per-frame samplers complete against it, but:

- prefer time bounds on `frame_inventory` when you only need a window;
- byte sampling reads the **most recent** N frames (cheap with the `(id)` / `(id, ts)`
  indexing), so it reflects current behaviour rather than the archive's beginning;
- leave `catalog_coverage`'s `include_byte_roles` off unless you want the per-frame
  byte breakdown — the frame/confidence diff is a single aggregation and stays cheap.
