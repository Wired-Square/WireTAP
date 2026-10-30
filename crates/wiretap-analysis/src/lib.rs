//! Payload analysis for WireTAP frames.
//!
//! - [`checksum`] — the identification pass: which bytes are worth handing to
//!   [`wslib_checksum`]'s solvers, and why the rest were not.
//! - [`scan`] — the orchestration over a whole capture: group by frame id,
//!   sample, identify, sweep, solve, rank.
//! - [`roles`] — what each byte does, addressed from the front: static,
//!   counter, sensor, value, the 16- and 32-bit counters, sensors and text that
//!   span columns, and the mux selectors that split a frame into cases.
//! - [`structure`] — a serial link's id and source-address bytes.
//! - [`hypothesis`] — candidate bit fields over one frame's payload, ranked
//!   against its byte roles. Reached by path: its `CandidateReason` is not
//!   [`structure`]'s.
//! - [`order`] — message order per bus: interval groups, cycle start ids and
//!   sequences, mux and burst timing, and the ids seen on more than one bus.
//! - [`mirror`] — mirror groups: ids carrying the same changing payload together.
//! - [`notes`] — what a byte profile says, as note codes for the caller to word.
//! - [`summary`] — the counts a Payload Changes or Frame Order report sums up.
//! - [`dashboard`] — a Dashboard panel's counters: the histogram and the bit
//!   toggles. Reached by path.
//! - [`draft`] — profiles and message order merged per protocol and frame, and
//!   the typed [`wslib_wiretap_catalogue`] ops that write them; the `byte_*` signals
//!   offered for a frame without a catalogue; Discovery's catalogue export.
//!   Reached by path.
//! - [`source`] — the levers over a store of recorded frames: byte profiles, a
//!   checksum scan and catalogue coverage over a [`source::PayloadSource`], and
//!   message order over a [`source::FrameSource`]. Reached by path.
//! - [`query`] — the analytical query kernels over rows already read, answering in
//!   [`wslib_wiretap_gateway`]'s result types. Reached by path.
//!
//! Per-byte-column statistics live in [`wslib_checksum::columns`], beside the
//! addressing they are indexed by. A caller that needs them
//! depends on that crate directly, as this one does; they are not re-exported.
//!
//! `wslib-checksum` answers *what algorithm is this byte*; this crate answers
//! the prior question — *is this byte a checksum at all* — and drives the scan
//! that puts the two together.
//!
//! The two crates stay separate, and the byte-role classifier sits here beside
//! the identification pass, reading the same [`ColumnStats`] from the front
//! rather than bringing a statistics set of its own. The reasoning is in the
//! WireTAP-lib vault, `Plans/lib-extraction-a-api.md`.
//!
//! [`ColumnStats`]: wslib_checksum::columns::ColumnStats

pub mod checksum;
pub mod dashboard;
pub mod draft;
pub mod hypothesis;
pub mod mirror;
pub mod notes;
pub mod order;
pub mod query;
pub mod roles;
pub mod scan;
pub mod source;
pub mod structure;
pub mod summary;

pub use checksum::{
    checksum_evidence, checksum_evidence_with_columns, solve_targets, ChecksumEvidence,
    RankedTarget, Rejection,
};
pub use mirror::{mirror_groups, MirrorGroup, TimedPayload, DEFAULT_MIRROR_WINDOW_US};
pub use notes::{byte_notes, ByteNote, ByteNotes, MuxCaseNotes, StaticByte};
pub use order::{analyse_order, BusOrder, OrderAnalysis, TimedFrame};
pub use roles::{
    classify_columns, detect_mux, find_patterns, infer_endianness, is_mux_like_sequence,
    profile_bytes, ByteColumn, ByteProfile, ByteRole, Direction, Endianness, Loop,
    MultiBytePattern, MuxAnalysis, MuxCase, MuxDetection, MuxSelector, PatternKind, Trend,
};
pub use scan::{
    analyse_group, scan_frames, scan_groups, ChecksumScanOptions, ChecksumScanResult,
    DiscoveredChecksum, FrameChecksumFinding, FrameKey, DEFAULT_MIN_LIKENESS,
};
pub use structure::{serial_structure, CandidateReason, FieldCandidate, SerialStructure};
pub use summary::{
    changes_counts, order_totals, BusCounts, ChangesCounts, OrderTotals, ProtocolOrderCounts,
};
