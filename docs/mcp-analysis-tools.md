# MCP analysis tools (headless capture / database analysis)

WireTAP's embedded MCP server (`crates/wiretap-app/src/mcp/`) exposes read tools that let an
agent inspect recorded CAN data **without any view open**. Alongside the existing
session/capture/catalog tools, these *analysis levers* run the same query engines
that back the Query app, against **either** a SQLite capture **or** a WireTAP
backend profile, and a catalog-coverage diff on top.

Implementation: [crates/wiretap-app/src/analysis.rs](../crates/wiretap-app/src/analysis.rs)
(orchestration; the byte-role classifier is `wiretap_analysis::profile_bytes`), the backend/sqlite query paths in
[crates/wiretap-app/src/dbquery.rs](../crates/wiretap-app/src/dbquery.rs) and
[crates/wiretap-app/src/capture_db.rs](../crates/wiretap-app/src/capture_db.rs), wired as MCP tools in
[crates/wiretap-app/src/mcp/tools.rs](../crates/wiretap-app/src/mcp/tools.rs).

## Protocol

The server speaks **MCP `2026-07-28`** over Streamable HTTP at
`http://127.0.0.1:<mcp_server_port>/mcp`, default port 8787. The hosting layer —
identity, the supported-version list, the `tools/list` cache hints, the bearer
gate, `Host`/`Origin` policy and connection tracking — is the shared
[`wslib-ai-mcp`](https://github.com/Wired-Square/wslib-ai-rs) crate (over `rmcp`
3.4); this repo owns only the tools
([crates/wiretap-app/src/mcp/tools.rs](../crates/wiretap-app/src/mcp/tools.rs)) and
the settings-to-lifecycle mapping
([crates/wiretap-app/src/mcp/mod.rs](../crates/wiretap-app/src/mcp/mod.rs)). It is
**dual-era**: the lib advertises `2026-07-28`, `2025-11-25` and `2025-06-18`, so a
client that still opens with the legacy `initialize` handshake keeps working
alongside one that sends stateless per-request `_meta`. `server/discover` is
answered from the same identity. Note that since rmcp 3.4 `initialize` only ever
negotiates a version that *has* a handshake — a client that calls `initialize`
asking for `2026-07-28` is told `2025-11-25`; a true `2026-07-28` client never
calls it.

Consequences worth knowing when reading results:

- **Every tool returns `structuredContent`** as well as the serialised JSON text
  block — both come from the single `ok_json` helper.
- **Tools are annotated.** Read tools carry `readOnlyHint`; the permission-gated
  tools carry `destructiveHint` / `idempotentHint`. Clients use these to decide
  what to auto-approve.
- **`tools/list` carries `ttlMs` (5 min) and `cacheScope: private`.** The set only
  changes when a permission gate does, which forces a server restart.
- **There are no protocol sessions** under `2026-07-28`, so the Session Manager's
  MCP connect/disconnect entries come from the lib's 90-second activity window,
  not a handshake. A
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

The live tools (`get_discovery_analysis`, `get_frame_order`, `get_decoded_signals`,
`get_live_frame_map`) take a `session_id` instead and read that session's frame
capture. Every read tool is **headless**: it reads the data store directly, so no
window need be open. Only `open_app` and the DOM tools drive the window.

## Tools

### `get_decoded_signals`
Decodes the newest 1000 frames of a session's capture against the catalogue
attached to the session — the one `open_session` bound from the profile's
`preferred_catalog`, or `set_profile_catalog` chose — and folds them into one
entry per **masked** frame id, newest last:
`{ frameCount, frames: [{ frameId, maskedFrameId, bus, t, signals, selectors,
headerFields, sourceAddress }] }`. `signals` is the stream's own shape
(`name, value, scaled, display, unit, muxValue, format`), merged by
`muxValue:name`, so a multiplexed frame reports the last reading of **every**
case it showed in that window, not only the case its newest frame carried;
`selectors` and `headerFields` are the newest frame's. `frame_id` restricts it to
one frame, as a masked decimal id (`"256"`) or a frame key (`"can:256"`). A
session with no frame capture, or no catalogue attached, is an error that says
which. The Decoder's own view filters do not apply: this is what the catalogue
says the latest frames mean.

### `get_live_frame_map`
The newest frame per identity in a session's capture, keyed as Discovery keys
them — `"can:256"`, `"modbus:5013"` — each `{ bytes, bus, is_extended, is_fd,
is_rtr, is_brs, is_esi, dlc, timestampUs }`; an RTR's `dlc` is the length it asks
for. `frame_ids` restricts it to those keys. A session with no frame
capture is an error.

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
For one `frame_id`, profiles its most recent `sample_limit` payloads (default 5000),
oldest first — see [Sampling](#sampling). The result is
`{ frameId, isExtended, frameIdHex, protocol?, sampleCount, minLen, maxLen, identical,
analysedFrom, columns, patterns, endianness, mux }`, the same profile Discovery's
Payload Changes shows:

- `columns` — one per byte from `analysedFrom` (0, or past a mux selector) to `maxLen`:
  `position`, `distinctValues`, `min`, `max`, `constantValue`, `changes`,
  `transitions`, `entropyBits`, `sampleCount` (past `minLen`, fewer payloads reach a
  byte), and a `role`:
  - `static` (`value`) — one value,
  - `counter` (`direction`, `step`, `rollover`, `looping`) — one step covers ≥80 % of
    transitions, or it cycles a small range,
  - `sensor` (`trend`: increasing / decreasing / mixed, `strength`, `rollover`) — ≥60 %
    of its moves go one way, or it oscillates actively,
  - `value` — two values, or at least 10 % of samples distinct,
  - `unknown` — varies, but fits none of those;
- `patterns` — adjacent bytes read together: `counter16`, `sensor16`, `sensor32`,
  `text`, with `start`, `len`, `endianness`, `range`, `sampleText`;
- `mux` — when byte 0 (or bytes 0–1) selects a case: the `detection` and each case's
  own `columns` and `patterns`. The top-level `columns` still cover every payload.

This replaced a three-role classifier (`static` / `counter` / `sensor`) and its
`bytes` array: `sensor` now narrows to trending or oscillating bytes, and what it used
to catch besides is `value` or `unknown`. Optional `protocol` restricts a frame id to
one protocol; omit it and a mixed capture profiles every protocol's rows for that
number together.

### `get_discovery_analysis`
The same profile for every frame of a session's capture: `session_id` (required),
optional `frame_ids` as Discovery's keys (`"can:256"`). Each frame reads its most
recent 5000 payloads. Without `frame_ids` the first 64 frames of the capture's
inventory are profiled and the rest counted in `skippedFrames`. A session with no
frame capture is an error. Discovery's Payload Changes reads the session's capture
through the same code, live or not, so the panel and an agent describe it alike.

Each frame also carries `notes` — what the profile says, as codes
(`{ frame: [{ code, … }], cases: [{ value, notes }] }`: `endianness`,
`varyingLength`, `burst`, `identical`, `multiplexed`, `caseSummary`, `statics`,
`counter`, `sensor`, `pattern`, `varyingValues`, `noSamples`) — and `burst`, set
when message order finds it sent in bursts. `mirrors` lists, per protocol, the
groups of ids carrying one changing payload together (`keys`, `sampleCount`,
`matchPercentage`, `samplePayload`). Bursts and mirrors read the capture's newest
`newest` frames with their timing, 100000 by default (Discovery's default live
window); pass a larger `newest` to read more of a long capture. `framesRead` says
how many were read.

### `get_frame_order`
Message order of a session's capture, the answer Discovery's Frame Order shows:
`{ captureId, protocols: [{ protocol, order }] }`. Each `order` holds the
capture-wide counts, one schedule per bus (`buses`: interval groups, start-id
candidates, cycle patterns, mux and burst timing) and the ids seen on more than
one bus (`multiBus`). Gaps and periods never cross buses, and a standard and an
extended id are different frames. It reads the capture's newest `newest` frames,
100000 by default (Discovery's default live window); pass a larger `newest` to read
more of a long capture. Optional `frame_ids`, and
`start_frame_id` (with `start_is_extended`, and `start_protocol` to name one
protocol) to walk cycles from one id instead of the likeliest.

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

`include_byte_roles` (default **false**) additionally attaches each present frame's
byte profile as `byte_roles`, in the `frame_byte_profile` shape without the frame
fields — one sampling query per frame, so it's heavy on a big DB; enable it
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

**`stop_session { session_id, keep_session? }`** stops the session and destroys
it, releasing its profile, so nothing is left for a human to close. Pass
`keep_session: true` to stop it but leave it listed, its capture still readable
through the capture tools.

### Test Pattern

The Test Pattern app's runs, for an agent driving both ends of a link — an
initiator on one host and a responder on another, each through its own MCP
server. Thin wrappers over `io_test.rs`; the wire contract is
`wiretap_protocol::testpattern`.

- **`test_pattern_start { session_id, mode, role?, duration_sec?, rate_hz?, bus?, use_fd?, use_extended? }`**
  — gated by **control**. `mode` is `echo`, `sweep`, `throughput`, `latency`,
  `reliability`, `loopback` or `auto`; `role` is `initiator` (default) or
  `responder`. Defaults: 10 s, 10 Hz, bus 0, classic, 11-bit. Returns
  `{ test_id }`. A responder runs until stopped, going back to `listening`
  between runs, so one serves every phase of an `auto` suite.
- **`test_pattern_state { test_id }`** — read tool. The `IOTestState` the panel
  reads: `status` (`running` / `listening` / `completed` / `stopped` / `failed`),
  `tx_count`, `rx_count`, `drops`, `duplicates`, `out_of_order`, `latency_us`,
  `peer`, `remote`, `sweep` rows and `auto_results`. A run is over once `status`
  is neither `running` nor `listening`; `completed` means it passed.
- **`test_pattern_stop { test_id }`** — gated by **control**. Idempotent; the
  final state stays readable.

## Writing catalogs

Three tools let an agent persist decode work, gated by **two catalog-specific
permissions** (Settings → MCP), both off by default and independent of the control
gate:

- **`validate_catalog { content }`** — always available (read-only): parses + validates
  the TOML and returns `{ valid, errors: [{field, message}] }`. A dry run for the two
  writers.
- **`create_catalog { filename, content | ops }`** — gated by **catalog write**. Creates a
  *new* file under the decoder directory; **refuses if it already exists**.
- **`update_catalog { filename, content | ops }`** — gated by **catalog modify**. Overwrites
  an *existing* catalog (by filename or display name); **refuses if it doesn't exist**.

Each takes either `content` (the full TOML) or `ops`: the `wiretap-catalog` edit ops,
tagged by `op` (`SetMeta`, `Set{Can,Serial,Modbus}Config`, `AddFrame`, `SetFrame`,
`UpsertSignal`, `SetMux`, `DeleteAtPath`, …), the same ones the Catalog Editor sends.
`create_catalog` applies them to an empty file; `update_catalog` to the file on disk,
keeping its comments. The ops apply the catalogue's authoring rules: a frame's Modbus
length is in registers, nothing the frame inherits is written, a new Modbus frame is
seeded with a signal, a mux with a blank name is named for its frame and bits, and a
blank key or a mask that is not hex is refused.

Both writers **validate before writing** and reject (without touching disk) if there
are any findings — so a malformed catalog can never be persisted, whether it came as
`content` or from `ops`; either way it is saved via `catalog::save_catalog`,
preserving comments, mux shorthands and mirror/copy inheritance. Filenames are
sanitised (no path separators or `..`; a `.toml` suffix is added if missing) and always
resolve under `settings.decoder_dir`.

The split lets a user grant *creating new* catalogues without granting *overwriting
existing* ones (or vice-versa). With neither granted, only `validate_catalog` is
exposed. Changing either toggle restarts the server so the gate takes effect.

## Sampling

Which frames `sample_limit` picks differs by question and by source, and the
difference is deliberate:

- **Byte roles** (`frame_byte_profile`, `get_discovery_analysis`, `catalog_coverage`'s
  byte roles) take the **most recent contiguous N**, oldest first. Direction, trend
  and looping read consecutive pairs: a stride multiplies a counter's step, and a
  stride equal to a loop's length makes a counter read as static.
- **A checksum scan over a capture** is sampled **evenly across the whole
  recording**. The rowids for a frame id come off the covering index in order, are
  strided in Rust (ceiling division, so the last frame is always reachable), and
  only the survivors read a payload. A capture is bounded and local, which is what
  makes reading the whole span affordable.
- **A WireTAP backend** is always sampled as the **most recent N**. Striding a
  multi-month archive means a full scan where the tail query is an index seek, so
  it reflects current behaviour rather than the archive's beginning. The gateway
  serves them newest first; the desktop puts them back in time order.

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
