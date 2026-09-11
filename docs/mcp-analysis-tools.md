# MCP analysis tools (headless capture / database analysis)

WireTAP's embedded MCP server (`src-tauri/src/mcp/`) exposes read tools that let an
agent inspect recorded CAN data **without any view open**. Alongside the existing
session/capture/catalog tools, these *analysis levers* run the same query engines
that back the Query app, against **either** a SQLite capture **or** a WireTAP
backend profile, and a catalog-coverage diff on top.

Implementation: [src-tauri/src/analysis.rs](../src-tauri/src/analysis.rs)
(orchestration + the pure byte-role classifier), the backend/sqlite query paths in
[src-tauri/src/dbquery.rs](../src-tauri/src/dbquery.rs) and
[src-tauri/src/capture_db.rs](../src-tauri/src/capture_db.rs), wired as MCP tools in
[src-tauri/src/mcp/tools.rs](../src-tauri/src/mcp/tools.rs).

## Protocol

The server speaks **MCP `2026-07-28`** (via `rmcp` 3.x) over Streamable HTTP at
`http://127.0.0.1:<mcp_server_port>/mcp`, default port 8787. It is **dual-era**:
`supported_protocol_versions()` in
[src-tauri/src/mcp/tools.rs](../src-tauri/src/mcp/tools.rs) advertises
`2026-07-28`, `2025-11-25` and `2025-06-18`, so a client that still opens with the
legacy `initialize` handshake keeps working alongside one that sends stateless
per-request `_meta`. `server/discover` is answered from `get_info()`.

Consequences worth knowing when reading results:

- **Every tool returns `structuredContent`** as well as the serialised JSON text
  block — both come from the single `ok_json` helper.
- **Tools are annotated.** Read tools carry `readOnlyHint`; the permission-gated
  tools carry `destructiveHint` / `idempotentHint`. Clients use these to decide
  what to auto-approve.
- **`tools/list` carries `ttlMs` (5 min) and `cacheScope: private`.** The set only
  changes when a permission gate does, which forces a server restart.
- **There are no protocol sessions** under `2026-07-28`, so the Session Manager's
  MCP connect/disconnect entries come from a 90-second activity window
  ([src-tauri/src/mcp/mod.rs](../src-tauri/src/mcp/mod.rs)), not a handshake. A
  legacy client's explicit `DELETE` still disconnects it immediately; everything
  else — every stateless client, and any legacy client that just exits — is
  expired by the window. Expect a disconnect entry to lag the client leaving.

Not implemented, deliberately: resources, prompts, sampling, roots, elicitation /
MRTR, the Tasks extension, `subscriptions/listen`, and OAuth. Auth is a single
optional bearer token; the transport binds to loopback and validates `Origin`.

Client setup for Claude Code, Claude Desktop, LM Studio and Ollama is in the
project vault (`Reference/mcp-client-setup.md`).

## Source addressing

Every analysis tool takes **exactly one** of:

- `capture_id` — a SQLite capture (from `list_captures`), or
- `profile_id` — a WireTAP backend profile (from `list_io_profiles`).

Backend time bounds are RFC3339 strings (`start_time` / `end_time`); for captures
they are converted to the capture's microsecond timeline automatically.

These are **headless** — unlike `get_decoded_signals` / `get_discovery_analysis` /
`get_live_frame_map` (which bridge to an open Decoder/Discovery view), they read the
data store directly, so no window need be open.

## Tools

### `frame_inventory`
Per-frame-id rollup: `count`, `first_us` / `last_us`, `max_dlc`, `is_extended` and
`protocol`, with a `frame_id_hex`. The "what frame ids exist and how often" lever.
Optional time bounds. **On a large archive this is a full-table GROUP BY — pass
`start_time` / `end_time` to scope it.**

Frame identity is **(protocol, frame_id)**: a mixed capture holds CAN `0x100` and
Modbus register 256 under the same number, and they are separate rows. A
WireTAP backend profile reads one protocol — the one it is configured for — so
every row reports that: `"can"`, or `"modbus_rtu"` for a Modbus archive, where
`frame_id` is `unit << 8 | function` of a whole RTU message and `frame_id_hex`
is still its plain hex (`0x120` is unit 1, function `0x20`). Without time bounds
a backend answers from its hourly rollup, which is why it is cheap there.

### `frame_byte_profile`
For one `frame_id`, classifies each payload byte over sampled frames:
`distinct`, `min`, `max`, `changes`, and a `role` of:

- `static` — never changes,
- `counter` — one dominant fixed step (≥80 % of transitions),
- `sensor` — otherwise varying.

This is the headless Rust equivalent of the frontend Discovery byte analysis
(`compute_byte_profile`). `sample_limit` (default 5000) bounds the work — see
[Sampling](#sampling) for which frames it picks. Optional `protocol` restricts a
frame id to one protocol; omit it and a mixed capture profiles every protocol's
rows for that number together.

### `frame_checksum_scan`
Finds checksums across every frame id in the source, or the `frame_ids` you name.

Two passes. **Identification** first, because most bytes on a real link are not
checksums and each one ruled out is a polynomial search not run. The decisive
test is arithmetic rather than a threshold: a checksum is a function of the other
bytes, so a column that changes while every other byte holds still cannot be one.
That removes counters and timers; constant padding and sensor readings (bytes
that sit still while the payload moves, or take far fewer values than there are
distinct payloads) go with them. Every column comes back with its verdict, so an
empty result reads as *"byte -1 never changes, byte -2 is a counter"* rather than
*"nothing found"*.

**Solving** then runs only on survivors: the eleven named algorithms by scored
sweep, plus sums with a constant offset and two's-complement sums, which no fixed
algorithm list can express. Set `search_custom_polynomials` to also recover an
arbitrary CRC polynomial — affordable because `init` and `xorOut` are not
searched at all. They cancel for equal-length payloads, so the answer follows
from residue agreement.

Note the consequence: for fixed-length payloads `init` and `xorOut` are **not
separately identifiable**. A recovered CRC reports one working pair plus the
`alternatives` that fit equally well; none is more true than the others.

`min_likeness` (0-100, default 50) widens or narrows what reaches the solver.
`sample_limit` (default 5000) bounds payloads per frame id.

**This is not merely equivalent to Discovery's Checksum Discovery — it is the same
call.** The panel sends a capture id and its frame selection rather than the
frames themselves, and both doors run `analysis::checksum_scan` with the same
sampling and the same default `sample_limit`. Neither can give a different answer
about the same capture, and neither loads the capture into the app to ask.

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
The Query app's analytical engines, dispatched to the backend or a capture by source:
`query_byte_changes`, `query_frame_changes`, `query_distribution`,
`query_gap_analysis`, `query_frequency`, `query_first_last`, `query_mux_statistics`.
Params and result shapes match the Query app (see
[capture-database-schema.md](capture-database-schema.md) for the underlying tables).

### Modbus discovery
Gated by **session control** (Settings → MCP), for a device whose register table
nobody published. Use them in this order:

- **`modbus_probe_function_codes { profile_id | host, port, unit_ids?, test_register? }`**
  — reads one address on each of FC03/FC04/FC01/FC02 per unit. Four requests per
  unit and no side effects, so it costs nothing to run first. Returns
  `{ units: [{ unit_id, responded, supported_types, holding, input, coil, discrete }] }`
  where each verdict is `values` / `bits` / `exception` / `silent`. **The
  exception-vs-silent distinction is the point**: an exception proves the device
  serves that function code and you asked for the wrong address, silence usually
  means it isn't implemented and sweeping it would burn the whole timeout budget.
- **`modbus_scan_registers { …, register_type, start, end, repeat?, … }`** — sweeps
  an address range. Runs as its own session writing into a frame capture; returns
  `{ session_id, capture_id, status, found, requests, blocks, gaps, notes }` where
  `blocks`/`gaps` are contiguous runs, not one row per register. Pass `repeat: 2`
  to sample every register twice so the Payload Changes tool can separate live
  telemetry from static configuration. `wait: false` returns immediately with a
  session id to poll.
- **`modbus_scan_unit_ids { …, start_unit_id, end_unit_id }`** — finds which slaves
  answer on a gateway, identifying each via FC43 where supported.
- **`get_modbus_scan_progress { session_id }`** — for sweeps started with `wait: false`.
- **`set_profile_catalog { profile_id, catalog }`** — gated by **catalog write**, not
  session control, because it is a catalogue operation and it writes persisted app
  settings. Binds an existing catalogue to a profile so `open_session` decodes that
  profile (and, for Modbus, builds its poll groups) without a human opening Settings.

### Handing WireTAP data

- **`ingest_bytes { bytes, name?, bus?, interval_us?, capture_id? }`** — puts raw
  bytes into a byte capture, as though a serial port had produced them. `bytes` is
  hex; separators and `0x` prefixes are ignored, and an odd digit count is rejected
  rather than silently shifted. Pass the returned `capture_id` back to append, so a
  line can be built up across calls — timestamps continue from where the capture
  left off rather than restarting at *now*, which would show the gaps between calls
  as gaps on the wire.

  The result is an ordinary byte capture, owned by no session and **pinned** (it
  survives a restart, because ingested data cannot be recaptured by reconnecting).
  Open it in Discovery to frame it, run the Serial Framing tool over it, or hand its
  id to any capture-taking tool. Timestamps only shape the hex dump: every framer
  works off byte order, never gaps.

  `scripts/modbus_rtu_feeder.py` generates a synthetic Modbus RTU line in exactly
  this format, for exercising the framer with no hardware.

`open_session` also takes **`register_ranges`** for Modbus profiles: poll an address
range directly instead of a catalogue's registers, so a device with no decoder can
still be watched live. An explicit range wins over a present `preferred_catalog`.
With neither, the open fails rather than falling back to a default sweep.

The IO source picker offers the same range in the UI and resolves the conflict the
same way, deliberately: the rule is one rule, so a session polls the same registers
whether a person or an agent opened it.

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

## Sampling

Which frames `sample_limit` picks differs by source, and the difference is
deliberate:

- **A capture** is sampled **evenly across the whole recording**. The rowids for a
  frame id come off the covering index in order, are strided in Rust (ceiling
  division, so the last frame is always reachable), and only the survivors read a
  payload. A capture is bounded and local, which is what makes reading the whole
  span affordable.
- **A WireTAP backend** is sampled as the **most recent N**. Striding a
  multi-month archive means a full scan where the tail query is an index seek, so
  it reflects current behaviour rather than the archive's beginning.

The consequence to remember: over a capture, an agent and the Discovery panel see
the same sample; over an archive, the sample is the recent window.

## Scale note

The reference dataset is ~12 months of CAN dumps (individual frame ids exceed 10⁸
rows). `frame_inventory` and the per-frame samplers complete against it, but:

- prefer time bounds on `frame_inventory` when you only need a window;
- **`frame_checksum_scan` against a WireTAP backend costs seconds, not
  milliseconds.** Measured over a live backend: all 62 ids of the Sungrow bus at
  the default `sample_limit` of 5000 — 310,000 payloads, one round trip per id,
  no time bounds — completed in under ~20 s of app time. The same scan over a
  SQLite capture is single-digit milliseconds. `sample_limit` binds on every id
  on any real archive, so the fetch dominates; the solve is CPU-local and stays
  in the low milliseconds. There is still no progress or cancellation, so expect
  a scan to sit there for that long, and scope it with `frame_ids` if you only
  care about a few;
- leave `catalog_coverage`'s `include_byte_roles` off unless you want the per-frame
  byte breakdown — the frame/confidence diff is a single aggregation and stays cheap.

Modbus sweeps answer in **run-length summary** rather than per-register rows: a
thousand-register sweep of a real device collapses to a handful of `blocks` and
`gaps`, a few hundred bytes rather than a few hundred kilobytes. The full detail
is in the returned `capture_id` — page it with `get_capture_frames`. `blocks` is
capped at 256 entries with `blocks_truncated` set, so a pathologically sparse
device can't produce an unbounded response either.
