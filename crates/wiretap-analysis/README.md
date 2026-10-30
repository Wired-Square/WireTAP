# wiretap-analysis

Payload analysis for WireTAP frames:
which bytes are worth solving as a checksum at all, the geometries to solve them
over, the scan that drives both across a capture, and what every other byte
does.

Where `wslib-checksum` answers *what algorithm is this
byte*, this crate answers the prior and cheaper question — *is this byte a
checksum* — which usually decides the answer, because most links carry no
checksum on most frame ids.

## What's here

- **`checksum_evidence`** — the per-column verdict: which bytes could be a
  checksum at all
- **`solve_targets`** — each surviving column crossed with every calculation
  range `wslib_checksum::calc_ranges` offers, so a checksum that skips a
  leading type byte reaches the solver and not only the sweep
- **`scan_frames` / `scan_groups`** — group by frame id, sample, identify,
  sweep, solve, rank
- **`profile_bytes`** — byte roles for one frame id: each column from the front
  classed static, counter (linear or looping), sensor, value or unknown, with
  mux detection (`detect_mux`) splitting a multiplexed frame into cases, and
  the patterns that span adjacent columns (`find_patterns`): 16-bit counters,
  16- and 32-bit sensors, text, and the byte order they imply. Input is oldest
  first and contiguous; ordering is the caller's job
- **`serial_structure`** — a serial link's candidate id bytes (one or two, in
  bytes 0–4) and source-address bytes (in the five after the best id), each
  with its values, a 0–100 confidence and the reasons as codes, not text.
  Checksum candidates stay `wslib_checksum::detect_checksum`'s
- **`hypothesis::rank_fields`** — a sweep of candidate bit fields over one
  frame's payload (`Sweep`), each a `wslib-bits` `PayloadField` scored 0–100
  against its byte profile, best first, with the reasons as codes. Capping the
  list is the caller's
- **`analyse_order`** — message order over a time-ordered capture, per bus:
  the periods ids group into, the ids that start a cycle and the sequence after
  them, mux and burst timing, and which ids appear on more than one bus. Gaps
  never cross buses; one call per protocol
- **`mirror_groups`** — ids whose changing payloads match within a time window,
  scored from the sparser id's side
- **`byte_notes`** — a byte profile's notes as codes (`ByteNote`), frame and
  mux-case level; the wording is the caller's
- **`dashboard`** — a Dashboard panel's counters: `histogram` over a signal's
  finite values, and `BitToggles`, how often each payload bit flips
- **`draft::Draft`** — a catalogue in the making, one frame per protocol and
  key: Payload Changes (`apply_profiles`) and Frame Order (`apply_orders`)
  merged in either order, and `to_ops`, the typed `wslib-wiretap-catalogue` edit ops
  that write it, with hex signals over every byte nothing else claims
  (`default_signals`). `draft::candidate_signals` lists the `byte_*` fields
  worth charting over a byte range
- **`draft::head_ops`, `frames_ops`, `modbus_ops`** — Discovery's catalogue
  export: the meta and protocol config a catalogue opens with, a frame per id
  seen, and a Modbus frame per register found. A header field a mask cannot
  say is written as `start_byte` + `bytes`; one with no bytes is not written
  and comes back as an `ExportFinding`
- **`query`** — the analytical query kernels over rows already read, oldest
  first, answering in `wslib-wiretap-gateway`'s result types: byte and frame changes,
  mirror validation (`mirror_compare_set` for a catalogue's inherited bytes), mux
  statistics, first/last, frequency, distribution, gaps and masked pattern
  search. Every kernel stops at `limit` results, never rows.
  `first_last_from_ends` answers from the end rows and a count, and `stats`
  stamps a caller's own result
- **`source`** — the levers over a store of recorded frames, so a panel and an
  MCP tool reading one capture answer alike. A `PayloadSource` lists its frames
  as `InventoryRow`s and samples one frame's payloads (`Sampling::Recent` for
  roles, `Spread` for checksums); `byte_profile(s)`, `checksum_scan` (sixteen
  ids resident at a time) and `catalog_coverage` run over it, the last keyed by
  the catalogue's `frame_id_mask` (a `modbus_rtu` row's messages re-framed into
  reads and matched by register window) and reporting each signal's confidence as
  `low`, `medium`, `high` or `unset`. A `FrameSource` gives a `FrameSelection`'s
  timed frames for `message_order`. Both build on `Source`, which owns the one
  `Error`, so a store implementing both names `S::Error` once. The methods
  return `impl Future + Send`, and nothing here needs a runtime. The
  off-by-default `testing` feature brings `MemorySource`, frames held in
  memory for a consumer's tests

The off-by-default `ts` feature derives `ts_rs::TS` on every public serde type,
and turns on the `ts` feature of `wslib-wiretap-catalogue`, `wslib-checksum`,
`wslib-bits`, `wslib-wiretap-gateway` and `wslib-wiretap-protocol`. Three are renamed so one directory holds
them beside those crates' types: `Endianness` as `NoteEndianness`,
`roles::MuxCase` as `MuxCaseProfile` and `hypothesis::CandidateReason` as
`HypothesisReason`.

Per-byte-column statistics live in `wslib-checksum`,
beside the addressing they are indexed by; reach for them there directly. Roles
read the same statistics from the front (`Anchor::Front`) rather than keeping
their own.

The classifier's thresholds are the desktop's TypeScript ones, pinned by the
golden fixture in `tests/fixtures/byte_roles`; the ranking's weights are pinned
the same way in `tests/fixtures/hypothesis`, and message order, mirrors and notes
in `tests/fixtures/analysis`, each difference from the TypeScript named in its
test.

The app is its one consumer, by path.

Identification **narrows** the search rather than deciding it, and the property
the tests pin is the one that matters — a real checksum must never be filtered
out. That argument is in `src/checksum.rs`, beside the test that holds it.
