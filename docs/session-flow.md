# Session Flow

This document describes how IO sessions are created, joined, driven, and torn
down in WireTAP. It is the canonical reference for the session subsystem.
For capture lifecycle and ownership, see [capture-flow.md](capture-flow.md).

## Architecture layers

```
┌─────────────────────────────────────────────────────────────────┐
│  UI                                                             │
│  Session chip + menu · IoSourcePickerDialog                     │
├─────────────────────────────────────────────────────────────────┤
│  useIOSessionManager        app-level orchestration             │
├─────────────────────────────────────────────────────────────────┤
│  useIOSession               per-subscriber React hook           │
├─────────────────────────────────────────────────────────────────┤
│  sessionStore               Zustand state, WS message routing   │
├─────────────────────────────────────────────────────────────────┤
│  WebSocket transport        binary frame/event delivery         │
├─────────────────────────────────────────────────────────────────┤
│  Rust backend (io/mod.rs)   IOSource trait, session lifecycle   │
└─────────────────────────────────────────────────────────────────┘
```

All frame data and most session events are delivered over a local WebSocket
rather than Tauri events — see [§ WebSocket transport](#websocket-transport).

---

## 1. Source traits

Every IO source declares its capabilities via two embedded structs on
`IOCapabilities` ([src-tauri/src/io/traits.rs](../src-tauri/src/io/traits.rs)):

```
┌──────────────────────────────────────────────────────────┐
│  InterfaceTraits                                         │
│    temporal_mode:  "realtime" | "recorded"               │
│    protocols:      ["can"] | ["canfd","can"]             │
│                    | ["serial"] | ["modbus"] | ...       │
│    tx_frames:      bool  (CAN, Modbus, framed serial)    │
│    tx_bytes:       bool  (raw serial)                    │
│    multi_source:   bool                                  │
├──────────────────────────────────────────────────────────┤
│  SessionDataStreams                                      │
│    rx_frames:      bool  (produces FrameMessage batches) │
│    rx_bytes:       bool  (produces raw serial bytes)     │
│  serial_link:      bool  (the transport is a serial link)│
└──────────────────────────────────────────────────────────┘
```

**`serial_link` is not `rx_bytes`.** The first says the transport is a serial
link the Discovery serial view belongs on; the second says raw bytes are actually
on the wire. A SLIP or Modbus RTU port is the first without the second, and the
two were one field until it had to mean both — Discovery tested `rx_bytes` to
decide whether to show the serial view at all, so making `rx_bytes` truthful
would have hidden the Raw Bytes and Framed tabs from every framed-serial source.
A FrameLink RS-485 interface is neither: it contributes `Protocol::Serial` to the
trait union but delivers framed messages, and its kind is `framelink`.

Both fields are non-optional on `IOCapabilities`. When multiple interfaces are
combined through `IOBroker`, `validate_session_traits()` merges them:
temporal modes must match, protocols are unioned, tx flags are OR'd. Sources
with `multi_source: false` cannot be combined with others.

### Source inventory

| Source            | Module                                   | Temporal  | Protocols     | tx_frames | tx_bytes | multi |
|-------------------|------------------------------------------|-----------|---------------|-----------|----------|-------|
| GVRET (TCP/USB)   | [io/gvret/](../src-tauri/src/io/gvret/)  | realtime  | can, canfd    | ✓         | ✗        | ✓     |
| slcan             | [io/slcan/](../src-tauri/src/io/slcan/)  | realtime  | can, canfd    | ✓/✗       | ✗        | ✓     |
| gs_usb            | [io/gs_usb/](../src-tauri/src/io/gs_usb/)| realtime  | can, canfd    | ✓/✗       | ✗        | ✓     |
| SocketCAN         | [io/socketcan/](../src-tauri/src/io/socketcan/) | realtime | can      | ✓         | ✗        | ✓     |
| Serial (framed)   | [io/serial/](../src-tauri/src/io/serial/)| realtime  | serial¹       | ✗         | ✗        | ✓     |
| Serial (raw)      | [io/serial/](../src-tauri/src/io/serial/)| realtime  | serial        | ✗         | ✓        | ✓     |
| MQTT              | [io/mqtt/](../src-tauri/src/io/mqtt/)    | realtime  | can           | ✗         | ✗        | ✓     |
| Modbus TCP        | [io/modbus_tcp/](../src-tauri/src/io/modbus_tcp/) | realtime | modbus | ✗         | ✗        | ✓     |
| Modbus RTU        | [io/modbus_rtu/](../src-tauri/src/io/modbus_rtu/) | realtime | modbus | ✓         | ✗        | ✓     |
| Modbus scan²      | [io/modbus_tcp/scan_source.rs](../src-tauri/src/io/modbus_tcp/scan_source.rs) | realtime | modbus | ✗ | ✗ | ✗ |
| FrameLink         | [io/framelink/](../src-tauri/src/io/framelink/) | realtime | (per rule) | ✓ | ✗        | ✓     |
| Virtual device    | [io/virtual_device/](../src-tauri/src/io/virtual_device/) | realtime | can\|serial | loopback | loopback | ✓ |
| WireTAP backend   | [io/recorded/backend_api.rs](../src-tauri/src/io/recorded/backend_api.rs) | recorded | can \| modbus_rtu³ | ✗ | ✗ | ✗ |
| Capture replay    | [io/recorded/capture.rs](../src-tauri/src/io/recorded/capture.rs) | capture | (inherited) | ✗ | ✗ | ✗ |

¹ Framed serial (SLIP, Modbus RTU, delimiter) emits frames, not raw bytes.
² A discovery sweep, not a device you configure — see *Modbus discovery* below.
  It cannot be paused (there is no coherent half-way state to pause into) and it
  ends itself when the sweep finishes.
³ One per profile: the gateway's archive has a `protocol` column and every read
  on it is CAN unless asked, so the profile names which it reads
  (`apiclient::ArchiveProtocol`). A Modbus archive row is a whole RTU message,
  `id` = unit << 8 | function, delivered as `modbus_rtu` — not `modbus`, which
  is a register poll and would read that word as a register number.

**Bus mappings are built from the profile, and that is a known gap.**
`sessions::profile_bus_mappings` runs before a connection exists, so the only
thing it can read is the profile's `interfaces[]` — an array the frontend writes
after a successful probe. When that probe never ran the array is absent and the
mapping falls back to a single `can0`. For FrameLink that is a **silent drop, not
a mislabel**: the device does send `iface_index 1` frames and `reader.rs`
discards them at `if !my_interfaces.contains(&sf.iface_index)`, with nothing
logged and no bus dimension in the view to suggest anything is missing. Measured
against the Home Assistant add-on, which serves the same interfaces on both its
endpoints, an unprobed FrameLink profile saw 20 of the 26 ids GVRET saw — the 6
it lost were all on bus 1. Probing the profile takes it to
`available_buses: [0, 1]` and 90 unique ids, i.e. parity with GVRET, which is why
the always-visible Probe button is the answer until the gap below is closed.

**One enumerator, in Rust (2026-09-03).** `profile_bus_mappings` is now the only
thing that answers "which buses does this profile declare", for every kind:
`parse_interfaces_from_profile` (GVRET `interfaces[]`, its `_probed_bus_count`
fallback, and virtual) falling through to `create_default_bus_mapping` (FrameLink
`interfaces[]` and the legacy single-bus tail). `get_profile_bus_mappings`
exposes it to the frontend, which caches it in `stores/profileBusStore.ts` and
applies only an output-bus offset on top — the picker and the session graph no
longer derive a bus list of their own. Two bugs fell out of the old arrangement
and are fixed: the TypeScript copy read `interfaces[]` for FrameLink but *not*
for GVRET or virtual, so a probed 2-bus GVRET reached a multi-source session as
one bus-0 mapping; and `resolve_source_config` synthesised a lone `device_bus: 0`
mapping whenever the frontend sent none, which is how *any* multi-interface
device lost its extra buses on that path. `apply_bus_mapping` passing an unmapped
device bus through unchanged is what made the GVRET half invisible — the frames
still arrived, un-remapped, while `available_buses` and `transmit_routes` never
knew the bus existed.

**A bus carries a protocol, and its traits follow from it (2026-09-03).** Each
`BusMapping` has a `protocol` — the *input*, set from the profile's saved value
and overridable per session by the source picker's per-bus dropdown — alongside
two *outputs* the frontend never sends: `traits`, always
`traits::traits_for_protocol(protocol)`, and `supported_protocols`, the options
the dropdown renders. `traits::normalise_bus_traits` re-derives both on the way
in, on the session-create path (`resolve_source_config`) and the running-session
hot-swap (`io::update_source_bus_mappings`) alike, so a stale or hand-written
traits blob cannot claim a capability the protocol beside it does not imply.
Seven copies of the protocol→traits match had accumulated across `sessions.rs`
and the GVRET module; there is now one. (`BusMapping` itself now lives in
`io/bus_mapping.rs` — it was only ever in the GVRET module because GVRET was the
first driver to need it.)

The protocol is taken as given rather than checked against the kind.
`traits::supported_protocols_for_kind` answers per *kind* and is deliberately a
default for the picker, not a gate: it is coarser than the truth, since a
FrameLink RS485 port or a virtual Modbus adaptor carries a protocol its kind's
list does not mention. A mapping that knows its own narrower list keeps it.

What this changes is **capability reporting** — the traits `IOBroker::new`
combines, and through them the FD checkbox in the transmit editor, the CAN-vs-
serial transmit view, and toolbox gating. It selects no codec: readers still
dispatch on `profile.kind`. Modbus on a serial port is a different mechanism
again (`framing_encoding: "modbus_rtu"` plus the attached catalogue's protocol),
which is why the dropdown deliberately does not offer it — a third way to say
the same thing would be free to disagree with the other two.

Two disagreements fell out and are fixed: `enable_fd` on slcan / gs_usb /
socketcan was read by the frontend registry but ignored by Rust, so an
FD-enabled slcan was *shown* FD-capable and *ran* classic CAN; and a probed-but-
unconfigured GVRET advertised CAN FD while the same device with a saved bus list
advertised plain CAN. Both now come from one derivation, and plain CAN is the
default a bus gets until something says otherwise.

**A source now revises its mappings once connected (2026-09-03).** The profile
is the starting guess; the device gets the last word. A driver that can
enumerate its interfaces sends `SourceMessage::MappingsResolved(source_idx,
mappings)`, the merge task records it under that source's **profile id**, and
`IOBroker` reads through it in all four places that matter —
`combined_capabilities().available_buses`, `effective_session_traits()`,
`route_for_bus()` for transmit, and `broker_configs()`, which is what the
session graph draws its bus handles from. Reconciliation rule, shared by both
drivers: the device decides which buses exist; a profile entry overrides only
`enabled` and `output_bus`; a bus the profile has never seen streams by default;
one the device does not report is dropped.

An earlier attempt (`91396ac`, reverted in `e2ad44d`) did the FrameLink half only
and was pulled because `available_buses` and `transmit_routes` were both built
pre-connect: frames arrived tagged `bus: 1` while transmit rejected bus 1 as
having no source. That objection is what the read-through closes — the eager
`transmit_routes` table is gone entirely, so there is one definition of the
routing rules rather than a pre-connect one and a post-connect one.

Both GVRET transports reconcile, and share one enumeration policy in
`gvret/common.rs::mappings_from_num_buses`: a device that answers is reconciled
to its count; a live link that stayed quiet keeps the profile's mappings (as
FrameLink does when a device reports no interfaces); a link that closed or
errored fails the source immediately, naming which of the two happened. Keeping
those apart is deliberate — collapsing them once reported a dead endpoint as a
device that ignores the command, which sends the reader at firmware instead of
at the network.

`probe_gvret_tcp` and `probe_gvret_usb` ask through the same `query_num_buses`
(hence its timeout parameter — a probe may wait longer than a reader), and
differ only in what they do with silence: a probe reports single-bus rather than
refusing, because its job is to let you add the device. Add a fifth caller by
reusing that function, not by writing the exchange again — the two probes used to
carry their own copy, and answered silence the opposite way from the streaming
path. Note FrameLink still spells the keep-the-profile rule itself in
`reconcile_bus_mappings`, so the two drivers agree by convention, not by
construction; the register carries the entry.

**Residual gap.** The serial half of `IOCapabilities` is settled before any
driver runs: `device_kinds::resolve_serial_framing` resolves a source's framing
from the session override, then the profile, then the kind default, and writes it
onto `SourceConfig` at creation — so `IOBroker` reads a settled answer rather
than an absence. That fixed the fields being *wrong*; they are still a
pre-connect guess, and a FrameLink RS-485 interface discovered at connect does
not flip a session into byte mode.

**Resolve serial framing once, at session creation.** `SourceConfig.framing_encoding`
used to be `None` for single-source sessions, on the reasoning that the reader
would read it off the profile — and it did. But `IOBroker` reads that same field
to decide `emits_raw_bytes`, `has_framing` and `rx_frames`, all *before* the
reader exists, and an absent framing read as `"raw"`. A SLIP or Modbus RTU device
opened on its own therefore got a bytes capture nothing wrote to, **no frames
capture at all**, and every framed row dropped by `append_frames_to_session`. Two
consumers deriving the same fact from the same optional field, one of them ahead
of the value being known, is the shape to watch for.

`has_framing` and `rx_frames` were two statements of the second rule, and only
one knew about live `set_framing` overrides; both now call
`IOBroker::emits_frames()`. **Add a new stream fact there, not beside it** — the
three that exist (`rx_frames`, `rx_bytes`, `serial_link`) are already computed at
three different times, which is the open register entry above.

**A serial setting is declared in one place and threaded whole:
`io::broker::SerialOverrides`.** `SourceConfig` embeds it with `#[serde(flatten)]`,
so the wire shape stays the flat keys the frontend sends; `MultiSourceInput`
flattens the same struct; the single-device command takes it as one argument; and
`run_source_reader` passes the `SourceConfig` down to `parse_profile_for_source`
rather than exploding it. **`parse_profile_for_source` returns a fully resolved
config** — framing, raw-bytes, CRC and both extraction triples — so no caller
re-applies an override afterwards; doing that in the spawner was how a session's
frame-id override reached the reader only because someone remembered to. On the
frontend the mirror is one `InterfaceFramingConfig` in `api/io.ts` and one
`serialPayload()`, used by all three send sites and by the picker.

**This was five enumerations of the same list, and every one of them had lost
something.** Three Rust structs and two parameter ladders down to the reader; three
TypeScript mappings, of which `createMultiSourceSession` had dropped
`min_frame_length`; and a second, narrower `PerInterfaceFramingConfig` in the
store that carried only `encoding` and `delimiterHex` — so the picker's *Capture
raw bytes* and *Validate CRC* ticks reached nothing at all, on any path. **A
setting enumerated at N sites is a setting silently dropped at the N+1th**, and
the compiler cannot help, because every one of those lists was individually
well-typed. Add a serial setting to `SerialOverrides` and it reaches the reader
on its own.

**A FrameLink device serves exactly one TCP client**, so `io/framelink/shared.rs`
pools one connection per device and every consumer — the reader and the ~40
rules/signal commands alike — holds a `ConnectionLease`. The last lease dropping
starts a 30 s linger, after which one process-wide sweeper evicts the entry;
dropping the last `Arc<FrameLinkSession>` runs its `Drop`, which aborts the IO
task and closes the socket (there is no explicit close to call). The linger is
what keeps a burst of short-lived rules commands on one warm connection. A
connection is created already idle, because a probe connects and reads the cache
without ever taking a lease. Before releasing, a reader calls `stop_stream` for
its interfaces — the connection may outlive the session, and nothing would be
reading those frames — bounded by a short timeout, since `STREAM_STOP` is sent
with no ACK flag and the library otherwise waits out its full 15 s command
timeout for a reply that never comes, once per interface, inside session stop. **Do not hand out a bare `Arc<ManagedConnection>`**: the
pool previously had no `remove` at all, so a stopped session held the device's
only client slot for the life of the process.

**Host resolution.** TCP-based sources accept either a hostname or a literal IP
for their host. GVRET TCP, Modbus TCP and FrameLink resolve through
[`io/net.rs::resolve_host_port`](../src-tauri/src/io/net.rs), a wrapper over
`tokio::net::lookup_host` that bounds the lookup with `DNS_TIMEOUT` and classifies
failures as `IoError::DnsResolution`. New TCP transports must resolve through that
helper — parsing `"host:port"` straight into a `SocketAddr` accepts only numeric
IPs and rejects any DNS name with "invalid socket address syntax".

MQTT and the WireTAP backend API are the exceptions: their client libraries
(rumqttc, reqwest) resolve internally, so the helper cannot wrap them. They get a
library-level bound instead — `net::CONNECT_TIMEOUT`, applied through
`NetworkOptions::set_connection_timeout` for MQTT and `connect_timeout` on the
one `apiclient::HTTP` client the backend's query *and* stream paths share — so an
unroutable address fails in seconds rather than inheriting the OS default.
Neither kind declares a `timeout` in `device_kinds`, so the bound is fixed rather
than per-profile. **New backend HTTP work goes through `apiclient::http()`**; a
second `reqwest::Client` is a second connection pool that has to be told about
the bound separately, which is how the streaming path came to lack one.

**Resolve first, then connect to the returned `SocketAddr`.** Passing a
`(host, port)` tuple to `TcpStream::connect` resolves *inside* the connect
future, so a DNS failure is indistinguishable from an unreachable host. That is
not hypothetical: `getaddrinfo` does not fail fast when the resolver itself is
unreachable (a VPN dropping, say) — it blocks until libc gives up. Before this
was bounded, GVRET TCP reported `[gvret_tcp(host:23)] connect timed out` for a
DNS outage, and FrameLink — which resolved *outside* its 5s timeout — hung
indefinitely with no message at all. A hostname problem and a connectivity
problem have different fixes, so they must read differently.

**A session whose sources all failed reports failure.** `IOState::Error` was
declared but never constructed, and the merge task emitted `stream-ended`
`complete` regardless — so a session that never carried a frame reported a clean
finish while `get_session_state` still said `Running`, and only the frontend
store knew otherwise. The merge task keeps the last source error and, on exit,
picks its reason through `stream_ended_reason(stopped, had_error)`: a deliberate
stop outranks everything, otherwise an error beats `complete`. Because the merge
task is detached and cannot reach the broker's `state` field, it writes to a
shared `fatal_error` slot that `IOBroker::state()` consults *ahead of* that
field; `start` and `stop` both clear it. On the frontend, `StreamEnded` maps
reason `error` to `ioState: "error"` — collapsing every non-paused reason to
`"stopped"` would overwrite the failure that arrived moments earlier.

**Device errors.** The serial-family read loops (serial, slcan, gvret_usb) route
read failures through `IoError` via one
[`serial::utils::send_serial_read_error`](../src-tauri/src/io/serial/utils.rs)
helper, which probes port presence (`serialport::available_ports`) to classify
access-denied as *in use* vs *disconnected* and emits a device-identified,
actionable message rather than a raw `os error`. Stream errors are shown once,
centrally, by the `SessionError` handler in `sessionStore.ts` — per-app `onError`
handlers only log (they must not raise their own dialog, or Sentry double-reports).

That central handler suppresses a small set of *expected* errors without a
dialog. Keep the predicate narrow and anchored (`EXPECTED_MISSING_ENTITY` matches
only a `Session`/`Capture` that has already gone — a teardown race). It was once
a bare `includes("not found")`, which also swallowed real faults on this channel:
SocketCAN's "pkexec not found", gs_usb's "Device not found" and FrameLink's
"Device '…' not found via discovery" all reached the error state with nothing
shown. When adding an error message, check it cannot be caught by that filter by
accident — and note the sibling `includes("Modbus read error")` clause is still an
unanchored substring test.

FrameLink joined that ladder late, and the gap was expensive. `fetch_capabilities`
used to return an empty probe on both its error and timeout paths, so
`connect_by_address` pooled a half-open connection, named it `host:port` and
returned `Ok`. A Home Assistant add-on speaking FrameLink protocol v3 to a
WireTAP built against v1 therefore presented as a **healthy session that streamed
nothing** — no dialog, no error state, `Running` throughout. A device that cannot
describe itself is not a device we have connected to: the failure is now an
`IoError::Timeout`/`IoError::Protocol` and the session errors out. Likewise a
FrameLink stream channel closing unasked-for is an `Error`, not the `Ended` it
used to send.

**`Ended` now carries an `EndReason`, and the merge task branches on it.**
*`Ended` = we asked; `Error` = we didn't* was a convention every producer agreed
on by spelling `"stopped"` or `"disconnected"` into a free-text reason, and the
merge task read neither — so a GVRET adapter pulled out of its socket, or a
serial port that returned EOF, ended the run as `"complete"`. `EndReason::Disconnected`
is the one variant `is_fault()` returns true for, and the merge arm raises
`emit_session_error` for it exactly as the `Error` arm does. A new driver has to
choose a variant, which is the point: the contract is checked rather than spelled.

**A FrameLink timeout is diagnosed, not just reported.** The protocol has no
handshake — `connect` writes nothing, so a successful TCP connect proves only
that a socket opened, and a peer on a different protocol version drops our
frames *before dispatch* without replying. A timeout is therefore ambiguous, so
[`framelink/version_probe.rs`](../src-tauri/src/io/framelink/version_probe.rs)
asks the device directly: one `PING` per protocol version `0..=15` in a single
write, then one read. The device answers the single dialect it understands and
ignores the rest, and `parse_frame` reports a foreign peer's version in
`FrameError::UnsupportedVersion(v)` — so nothing needs hand-parsing, and only
the outgoing header is assembled by hand (a test pins it byte-identical to
`build_frame`, which can only stamp our own version). Four outcomes: the peer
speaks *v* (name both versions, point at firmware upgrade — which works, since
SMP shares nothing with this codec); it answered unintelligibly (firmware
predating the CRC removal, which shipped without a version bump); it speaks our
version (so the fault is elsewhere — report the original error and do **not**
claim a mismatch); or silence, which on a device that serves exactly one client
is `IoError::busy`.

Three constraints on that path, each of which was got wrong first:

- **Drop the `FrameLinkSession` before probing.** One client at a time means the
  probe cannot connect until the failed session's socket is closed.
- **Only probe a timeout.** A decode failure means the device already answered
  in our version, so the verdict is necessarily "same version" and the window is
  spent to reach an arm that discards it.
- **One read, not a drain.** `read_to_end` returns at EOF and the device holds
  the socket open, so waiting for it burned the whole window even when the reply
  arrived immediately — and reading a cancelled `read_to_end`'s buffer relies on
  behaviour tokio does not specify.

---

### Connection defaults — one table

What a device kind's `connection` map holds — its defaults and its required
fields — is declared once, in
[io/device_kinds.rs](../src-tauri/src/io/device_kinds.rs). Read it before adding
a device kind or a connection field.

**Defaults are resolved at read time, never written to disk.** The `req_*` and
`conn_*` accessors take the profile's value, else the kind's declared default,
so a profile hand-edited into `settings.json` and one built by the form behave
identically. `apply_defaults` exists for the other job — seeding a *new*
profile's map — and must not be used on a profile about to be saved: a default
written into `settings.json` stops being a default, and changing it in a later
release would then reach only profiles created after the change.

`req_*` returns a named error for a field it cannot resolve; `conn_*` returns
`Option` and is for the three fields the table deliberately leaves undeclared,
where absent is itself an instruction (`gs_usb.serial` — take whichever adapter
is there; `socketcan.bitrate`/`data_bitrate` — leave the interface as the system
configured it).

This replaced five copies of the table in Rust — the broker spawner,
`create_reader_session`, `probe_device`, `probe_gvret_device` and
`modbus_endpoint` — which had already drifted from the four in TypeScript. Three
disagreements were resolved in the process, the third of them a real fault:

| field | was (Rust) | was (TS form) | now |
|---|---|---|---|
| `gvret_tcp.host` | `127.0.0.1` | `192.168.1.100` | `192.168.1.100` |
| `modbus_tcp.host` | `127.0.0.1` | `192.168.1.100` | `192.168.1.100` |
| `slcan.silent_mode` | `false` | `true` | `true` |

An slcan profile saved before `silent_mode` existed was **shown as listen-only
and run as active** — `IOConnectionFields` renders `silent_mode !== false` while
the reader took `.unwrap_or(false)`. `transmit.rs` had it right (`true`); the
reader was the one that disagreed, which is why the symptom was an adapter
ACKing on a bus the user believed it was only listening to.

Still to come: `applyConnectionDefaults` and `validateProfileForm`
([src/settings/ioProfileForm.ts](../src/settings/ioProfileForm.ts)) are to seed
from the `default_connection_for_kind` and `validate_io_profile` commands rather
than carry their own copies.

---

## 2. Source selection

All sources — hardware devices, databases, recorded sources, and captures — are
selected through a single dialog, [IoSourcePickerDialog](../src/dialogs/IoSourcePickerDialog.tsx).
Clicking the session chip opens the **session menu**; its **Change source** item
opens the picker (with no current source, clicking the chip opens it directly).

```
┌────────────────────────┐   Change source    ┌──────────────────────────┐
│   Session chip + menu   │  ───────────────▶  │  IoSourcePickerDialog    │
│    (SessionControls)    │                    │                          │
└────────────────────────┘                    │  Loads on open:          │
                                              │   • IO profiles          │
                                              │   • Orphaned captures    │
                                              │   • Active sessions      │
                                              │   • Profile usage map    │
                                              │   • Bookmarks            │
                                              └────────┬─────────────────┘
                                                       │
                                     ┌─────────────────┼─────────────────┐
                                     ▼                 ▼                 ▼
                               realtime source   recorded source     pick an active
                               (profile)         (backend, capture) session to join
```

Action buttons are **trait-driven**. A source with `temporal_mode: "realtime"`
gets `[Connect]`; a `recorded` source gets `[Load]` and `[Connect]`. An
existing session gets `[Join]` / `[Restart]` / `[Resume & Join]`. Joinability
is gated by `InterfaceTraits.multi_source`.

### Where a device lives — saved and ad-hoc profiles

A device is an `IOProfile`, and it lives in one of two places:

| | Saved | Ad-hoc |
|---|---|---|
| Stored in | `settings.json` (`io_profiles`) | `io::ephemeral`, in memory |
| Id | `io_<epoch_ms>` | `adhoc_<epoch_ms>` |
| Lifetime | Forever | This run |
| `IOProfile.ephemeral` | `false` (skipped on serialise) | `true` |

**Every profile consumer sees both, with no code of its own.**
`settings::load_settings` (and `load_settings_sync`) call
[`ephemeral::overlay`](../src-tauri/src/io/ephemeral.rs), which appends the
ad-hoc devices to `io_profiles` on the way out; `save_settings` drops them again
on the way in. So `choose_profile_by_id`, `resolve_source_config`, the broker
spawner, `probe_device`, transmit, Modbus and MCP all resolve an ad-hoc device by
id exactly as they resolve a saved one. The alternative — a resolver threaded
through ~22 lookup sites, several returning a borrowed `&'a IOProfile` — is what
this avoids.

Two rules hold the design up, both enforced in Rust:

- **A saved profile wins an id collision** (`overlay` skips an id already
  present), and `register_ephemeral_profile` rejects a saved id up front so the
  collision cannot be created by accident.
- **An ad-hoc device cannot be discarded while a session holds it** — the
  session would be left pointing at a profile nothing can resolve. The UI hides
  the affordance; `unregister_ephemeral_profile` enforces it against races.

The frontend keeps the two apart: `normalizeSettings` filters `ephemeral` out of
`io_profiles`, and [`useAllIOProfiles`](../src/hooks/useAllIOProfiles.ts) merges
the settings store with `adHocProfileStore` for anything that feeds session
start. `useIOSessionManager` resolves ids through a `findProfile` that also
reads the ad-hoc store imperatively — a device registered and connected in the
same handler is not in the prop array's closure yet.

### Reconfiguring a device

Changing a device's connection parameters — bitrate, baud rate, 8N1, host, port
— is **one backend command**,
[`io::profiles::reconfigure_device`](../src-tauri/src/io/profiles.rs):

```
reconfigure_device(profile_id, connection, session_id?)
        │
        ├─ credentials::split_secrets     secrets → keyring, markers stay
        ├─ write                          settings.json, or the ephemeral registry
        ├─ clear_probe_cache              the id is unchanged; the device may not be
        └─ reload_session_source          if a session is streaming it
```

The steps are inseparable, which is why it is one command rather than a frontend
sequence: the profile must be written *before* the source respawns, or the device
comes back on the settings that were just replaced.

`reload_session_source` re-applies the bus mappings the source already has, which
is a remove-then-add through the broker — and the merge task re-reads the profile
when it respawns the source. **The session id does not change**, so every app
watching simply sees the device reconnect.

Reconnecting is a session-lifecycle operation, not a device capability: no device
can re-tune a bitrate or a baud rate in place, so there is nothing per-type to
dispatch on. It needs `broker_configs()`, so a single-source session (which boxes
its device directly) reports the limit rather than failing obscurely.

Two surfaces open this, both landing on the same command:

- **The session menu's interface rows** ([SessionControls](../src/components/SessionControls.tsx)),
  one row per interface, so a multi-bus session needs no "which device?" step.
- **The pencil on a device row** in the source picker.

Both open [DeviceSettingsDialog](../src/dialogs/DeviceSettingsDialog.tsx), hosted
once at the app root and driven by `deviceEditorStore`. It dispatches globally
rather than taking a prop because the action is app-agnostic — the backend does
the whole thing from `(profileId, sessionId)` — and the alternative is a prop
threaded through six app top bars.
[DeviceEditor](../src/dialogs/io-source-picker/DeviceEditor.tsx) inside the
picker is **creation only**; it needs the kind selector, the name and the connect
that follows, none of which apply to a device that already exists.

---

## 3. From dialog to backend

```
IoSourcePickerDialog
        │   (Connect / Load / Join / Switch clicked)
        ▼
useIOSourcePickerHandlers
        │   ── onBeforeStart() app cleanup hook
        │   ── merges framing / bus mappings / time bounds
        │   ── routes to manager method
        ▼
useIOSessionManager
        │   watchSource(profileIds[], opts)       unified entry
        │   loadSource(profileIds[], opts)        (recorded ingest)
        │   joinSession(sessionId)
        │   ── generates session ID (see § prefixes)
        │   ── onBeforeWatch callbacks
        │   ── flags: isWatching / isLoading
        ▼
useIOSession              (wraps one sessionStore session for one subscriber)
        │   ── registers unique subscriberId
        │   ── subscribes to WS messages for this session
        │   ── exposes start/stop/pause/resume/seek/leave/reinitialize
        ▼
sessionStore.openSession
```

### IO-profile secrets

A profile's passwords and API keys are **not** in `settings.json` — the
connection map holds only a `_{field}_stored: true` marker, and the value lives
in the OS keyring under `IO_PROFILE_SERVICE`
(`com.wiredsquare.wiretap.io-profiles`), account `{profile_id}:{field}`.
Catalogue-sharing tokens are in a separate bucket (see
[catalog-sharing.md § Auth](catalog-sharing.md#auth)).

Resolve secrets through **`credentials::resolve_secret(profile, field)`** — never
re-implement the marker check. It reads the keyring when the marker is set and
falls back to a plaintext connection value for pre-keyring profiles, so both
shapes work at every call site (`sessions.rs` API/MQTT branches,
`dbquery.rs`). `apiclient.rs` uses the `has_stored_marker` predicate directly
because it distinguishes "marker set but no entry" from "keyring error" in the
message it returns.

Only the prefixed marker is recognised. Unprefixed variants (`password_stored`)
were never written by any release and their read support has been removed.

Writing is the mirror of that, and equally not to be re-implemented:
**`credentials::split_secrets(&mut profile)`** moves any plaintext secret out of
`connection` into the keyring and leaves the marker. Every path that persists a
profile goes through it — a password left in `connection` would be serialised
into `settings.json`, which `save_settings` does nothing to prevent. A field the
caller did not supply is left alone, so an edit that never touched the password
keeps the stored one rather than clearing it. Ad-hoc devices deliberately skip
it: they never reach disk, and `resolve_secret` falls back to the inline value
when there is no marker.

**Legacy namespace drain (transitional).** Entries written before the CANdor →
WireTAP rename sit under `com.candor.io-profiles`. `get_credential` falls back to
that namespace, copies the value into the live one and deletes the old entry, so
a secret migrates on its way to being used; `migrate_legacy_io_profile_credentials`
additionally sweeps entries nothing ever reads, called via `spawn_blocking` from
`setup` — deliberately **off** the pre-first-paint path, because `setup` already
`block_on`s `load_settings` and keyring access is OS IPC that can block or prompt.
Deletes clear both namespaces, or the fallback would resurrect a deleted secret.
`credentials.rs`'s module doc names the deletable unit; remove it once 0.10 is
well established.

### Session ID prefixes

Session IDs are independent of profile IDs. Format: `{prefix}_{6-hex}`. The
prefix is **cosmetic** (logs/debugging), with one exception: Discovery reads the
`m_scan` prefix to tell a sweep from a poller in the beat before the roster
reconcile gives it `source_type`. Add no others.

`generate_session_id` resolves the `b_` vs `f_` choice for a serial profile
itself, through `device_kinds::resolve_serial_framing` — the frontend cannot know
a profile's framing before the session exists, so it always said `false` and
every raw serial session came out `f_`. An explicit `emit_raw_bytes` from the
picker still wins.

| Prefix | Meaning                                                    | Generated in |
|--------|------------------------------------------------------------|--------------|
| `f_`   | realtime + rx_frames (CAN, framed serial, GVRET, gs_usb…)  | Rust `generate_session_id` ([sessions.rs](../src-tauri/src/sessions.rs)) |
| `b_`   | realtime + rx_bytes (raw serial), or capture replay session | Rust (realtime) / `generateCaptureSessionId` (capture) |
| `m_`   | realtime + modbus protocol                                 | Rust `generate_session_id` |
| `s_`   | realtime fallback                                          | Rust `generate_session_id` |
| `t_`   | recorded (WireTAP backend, CSV import)                           | `generateRecordedSessionId` ([useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts)) |

**Realtime** session IDs are generated by Rust: the multi-source watch path calls
the `generate_session_id` command, which infers the prefix from the profiles'
output type (`protocol_for_kind`). The frontend no longer infers it. The
recorded/capture/load fixed prefixes (`t_`/`b_`/`load_`) are still generated by
small frontend helpers (no inference) pending the Phase 4 create-flow consolidation.

Captures have their own immutable `capture_id` (6–8 char random string such
as `xk9m2p`). **The capture ID is not the session ID** — a session replaying
a capture gets a fresh `b_` session ID that owns the capture. See
[capture-flow.md § Identity](capture-flow.md#3-identity).

### `sessionStore.openSession` steps

Defined in [src/stores/sessionStore.ts:711](../src/stores/sessionStore.ts#L711).

1. Check if the session already exists locally (connected) — if so, register
   another subscriber and return.
2. Check if the session exists in the Rust backend via `getIOSessionState`.
3. Destroy any session that was left in `error` state.
4. Create or join:
   - **4a** Backend exists: `registerSessionSubscriber` → read caps/state/capture.
   - **4b** Backend missing: `createIOSession` (or `createCaptureSourceSession`
     for capture replay) then `registerSessionSubscriber`.
5. Subscribe to the session's WebSocket channel and wire message handlers
   (see [§ WebSocket transport](#websocket-transport)). Start the heartbeat
   interval.
6. **Step 5.5** — auto-start playback for recorded sources (WireTAP backend, CSV).
   Capture replay sessions explicitly do **not** auto-start — the user drives
   playback manually. See [sessionStore.ts:992-999](../src/stores/sessionStore.ts#L992-L999).
7. Create/update the `Session` entry in the Zustand store and return.

### Headless open — the MCP path

[src-tauri/src/mcp/session.rs](../src-tauri/src/mcp/session.rs) is the Rust-native
equivalent of the flow above, for `open_session` with no window open. It calls the
same `create_reader_session`, then does the three things the frontend would have
done:

- **Starts the source.** `create_reader_session` leaves recorded sources stopped so
  the frontend can register its frame listener before frames flow (step 5.5 above is
  the frontend half). Headless there is no listener to race, so `open` starts it
  itself — only when `Stopped`, since `start_session` is idempotent for `Running`
  but would restart a `Paused` one, which an explicit `session_id` can reach. If the
  start fails the session is destroyed rather than left holding the profile open.
- **Binds the profile's `preferred_catalog`** via `ws::dispatch::attach_catalog`,
  before the start, so frames decode from the first one. This is what puts a value
  on `ActiveSessionInfo.catalog_path` — which every session-aware panel mirrors
  one-way through `useSessionCatalog` — so a session later surfaced by
  `attach_source` arrives **decoded** in Decoder/Dashboard/Query rather than as a
  raw stream. A catalogue that fails to parse is logged and skipped; the session
  still opens.
- **Passes a time window through.** `start_time` / `end_time` / `speed` / `limit`
  reach `create_reader_session`'s existing parameters, each overriding the profile's
  own `connection` value without modifying the profile
  ([sessions.rs](../src-tauri/src/sessions.rs) — `start_time.or(start_from_profile)`).
  Without them a recorded source replays its entire archive from the head, which on
  a long-term store is rarely what an agent wants; `speed` defaults to `0` (as fast
  as the source allows).

- **Builds Modbus poll groups.** A Modbus session reads nothing until it is told
  what to poll, and that normally comes from the profile's catalogue. When the
  device has no catalogue yet — the whole point of discovery — `register_ranges`
  supplies an address range instead, via
  [`build_polls_from_ranges`](../src-tauri/src/io/modbus_tcp/ranges.rs). An
  explicit range **wins over** a present `preferred_catalog`, which is how you
  re-sweep a device whose catalogue you already know is incomplete. With neither,
  the open fails naming both remedies: silently sweeping an unknown industrial bus
  on an agent's behalf is not a safe default.

A keepalive task then touches the MCP subscriber every 10 s so the heartbeat
watchdog doesn't reap a session with no window attached.

### Modbus discovery

Three operations, in the order you'd use them against an unknown device:

| Step | Entry point | What it answers |
|------|-------------|-----------------|
| Probe | `modbus_probe_function_codes` | Which of FC01–FC04 does this device answer? |
| Sweep | `create_modbus_scan_session` → `ScanJob::Registers` | Which addresses exist? |
| Poll  | The picker's **Poll a register range**, or `open_session` with `register_ranges` | Which of them change? |

The probe is a plain call — at most four requests per unit, no frames, no
capture — so its verdict table lives in the toolbox store rather than arriving
through the frame path. It still opens a results tab like every other tool: a
verdict you read against the sweep you run next is not something to lose by
closing the dialog it was launched from. The sweeps are sessions
(`ModbusScanSource`), because owning a session
is what gets them a capture, the analysis tools, capture paging and
cancel-as-`stop_session`. The session id *is* the scan id, so sweeps against
different devices run concurrently; what cannot overlap is two sweeps of the same
`host:port`, which `create_modbus_scan_session` refuses by name.

All three take the device from a picker rather than from a session — see
*Connection contention* below for why they run with no source selected.

**Polling needs a poll set, and a catalogue is not the only way to author one.**
`modbus_polls_from_ranges` turns "read these addresses this often" into poll
groups, chunked and clamped to the protocol maximum per register type. The IO
source picker offers it for the selected Modbus source (`ModbusPollConfig` → the
picker's `modbusRanges`, built into `modbusPollsJson` in
`useIOSourcePickerHandlers` before the watch starts), which is what lets
Discovery open a Modbus session that actually reads something — a catalogue is
loaded only by the Decoder. It is off by default: enabling it puts continuous
traffic on someone's device. The control is session-level because
`modbusPollsJson` is: one poll plan is injected into every Modbus source in the
session, so a per-row control would promise a per-device plan the session cannot
keep. It carries the profile's unit id, since the poll loop sets the slave per
request and a spec that omits it silently reads unit 1.

**A range beats a catalogue** when both are present, in the UI and over MCP alike
(`mcp::session::open`): ticking the box is an explicit act, and re-reading a span
the catalogue already covers is how you check a catalogue you suspect is
incomplete. The two agreeing is the point — the same session should not poll
different registers depending on who opened it.

The interval is validated in `build_polls_from_ranges` rather than at each
caller. A zero interval is not a fast poll but a panic: `Cadence` hands it to
`tokio::time::interval`, which rejects a zero period — inside a detached poll
task, where it would take the source down with no diagnosis.

The distinction the probe draws is the load-bearing one. A Modbus **exception**
proves the device implements that function code and the address was simply wrong;
**silence** carries no information at all and usually means the function code is
unimplemented. The sweep treats them differently for the same reason: it bisects
a chunk that excepted (the reply localised the fault) but not one that went
silent, because bisecting silence turns a single sweep into thousands of
full-timeout requests. After `max_consecutive_timeouts` silences it abandons that
register type and records why.

**Progress rides the session channel.** A sweep's progress is pushed as
`ModbusScanState` (0x1A) on the scan session's own channel — the same one its
frames use — throttled to 2 Hz by the caller-side `SignalThrottle`. That
placement is load-bearing rather than tidiness: the terminal status and
`StreamEnded` now share one mpsc, so they are ordered rather than racing across
two transports, and because the whole state is *pushed*, `ModbusScanSource::stop`
clearing the scan-state store can no longer strand a reader that arrived late.
It was previously a Tauri event carrying nothing, answered by a command
round-trip.

**The results tab is opened once the session exists, not before.** Discovery's
`runModbusScan` creates the scan session, joins it, and only then calls
`startModbusScan`. The store record *is* the tab, so a sweep the backend refuses
would otherwise leave an empty one behind. (Until `ownsData` landed there was a
second reason: joining runs `onBeforeWatch`, which cleared every tool result
including the sweep's own — that is no longer true.)

**Scan tabs accumulate; analysis tabs do not.** `TOOL_TAB_CONFIG` marks the three
Modbus tools `ownsData`, and `clearAnalysisResults` skips those — so working
through a device leaves probe, unit scan and register sweep tabs side by side
instead of each one wiping the last. The distinction is real rather than a
convenience: an analysis tool describes the frames on screen and is invalidated
by dropping the source, whereas a sweep went and got its own answer.

That is only safe because each tab can find its own rows. `ModbusScanResultView`
reads the shared frame store **only while its own sweep is the session on
screen** (`sessionId === currentSessionId`), which is what fills it live and
costs nothing — and it subscribes to `frameVersion` only then, so a finished tab
does not rebuild itself on another session's flushes. Start a second sweep and
the store is cleared and refilled with that one's registers, so the older tab
falls back to `captureId` and asks for `get_capture_latest_frames` — one row per
`(protocol, frame_id)`, reduced in SQLite next to `get_frame_info`, which already
groups the same way. That matters because a sweep writes each register once *per
pass*: a 20-pass sweep of 4096 registers is ~80k rows for a table of 4096, and
reading them all to keep the last of each ships 20× the data for the same answer. Without the fallback the older tab would keep its heading
and silently show the newer sweep's values.

**`capture_id` rides `ModbusScanState`** rather than being read off whichever
session Discovery is joined to. The capture is created in
`ModbusScanSource::start`, which runs *after* the subscriber attaches, so
registration cannot report it — and observing it from the session only works
while someone is still watching, which is exactly not the case for a tab that has
to outlive the sweep. Sending it on every tick means the first progress message
settles it.

A scan result therefore keeps its `sessionId` for life; `isScanning` is what
bounds the progress subscription and what Cancel targets.

The ordering only holds because of `markSessionSwitch` (§ App cleanup on
teardown). Joining the scan session is what empties the poller session, and its
`destroyed` arrives *after* the tab has been opened — so without that guard a
second, asynchronous `onBeforeWatch` would clear the tab all over again.

MCP is the exception, and deliberately: it is in-process Rust rather than a
WebSocket client, so it reads the same state from the store and waits for a
sweep's summary through `await_scan_result`.

**Connection contention.** A sweep opens its own connection. Routing it through
a running source's connection would avoid that and is not implemented: the poll
loop's `Arc<Mutex<Context>>` is a local inside `start()`, reachable from no
registry, and sharing it would let a scan timeout's reconnect swap the socket
under the poll tasks.

**The tools run from "No source", and are withheld while any source is
selected.** `SessionShape.hasSource` is the whole condition
(`toolboxGating.ts`), and it is not Modbus-specific: a CAN or serial session
withholds them just as a Modbus one does. Three things make that the right shape
rather than a restriction:

- A sweep **names its own device**. `ModbusConnectionFields` picks a saved
  profile or takes a typed address, and `create_modbus_scan_session` needs
  neither a session nor a catalogue — so there is nothing a session could supply.
- A sweep **takes the view over**: Discovery joins the scan session to show the
  results. Joining is what empties and destroys whichever session was selected
  (see § App cleanup on teardown), so a sweep launched from a live session
  silently kills it.
- Nothing else can be holding the device, because this app is holding nothing.
  `endpoint_in_use_by_poller` still refuses a sweep when *another* app polls the
  same endpoint — that refusal is by name, and it is the only contention check
  that has to survive.

A sweep's own session is exempt (`isModbusScanSession`, on the `m_scan`
session-id prefix). Chaining probe → unit scan → register sweep is how an unknown
device gets worked out, and each answer aims the next; making the results tab
withhold the tool that produced it would break the loop it exists to serve.

Two consequences worth knowing. The **Tools button itself is never disabled** —
at "No source" with no frames the Modbus tools are still runnable, so a greyed
button would hide the one thing the toolbox has to offer. And the top bar's poll
switch (`useModbusPollControl` → `pause_source_polling`) is now **only** a
session control: it pauses and resumes the selected Modbus session's poller and
gates nothing. Pausing stops requests but keeps the socket; only stopping the
session frees it.

`create_modbus_scan_session` still takes `target_session_id`, `stop_target` and
`allow_contention`, and does the whole sequence itself, in this order:

1. **Resolve** the device from the target session — necessarily first, because
   `stop_and_switch_to_capture` replaces a session's profile ids with its capture
   id, so a stopped session can no longer name its own device.
2. **Refuse** — `scan_holding` for a competing sweep, then
   `endpoint_in_use_by_poller` for a competing poller. The target is excluded by
   name: the caller has already dealt with it. Both precede any stop, so a
   rejected sweep cannot leave the caller's session stopped for a scan that never
   ran.
3. **Stop** the target, freeing the socket — only when `stop_target` is set.
4. **Create** the scan session.

Keeping all four inside one command is what makes that order unloseable.

**`target_session_id` and `stop_target` currently have no caller.** Discovery
passes neither — it runs from "No source", so there is no target session to
resolve, stop or exclude — and MCP passes `None, None, Some(true)`, naming its
own device and opting out of the poller check because an agent has no way to
answer a refusal. So `allow_contention` is the only one of the three that is
live, and the retarget/stop branches are reachable capability with nobody
exercising it. Either give them a caller or delete them; don't let this
paragraph go on implying one exists.

`endpoint_in_use_by_poller` counts a **paused** session as holding the device,
not just a running one — pause stops requests and keeps the socket, so a paused
poller contends exactly as a live one does. `scan_holding` only ever saw other
*sweeps*.

Once a sweep starts, Discovery joins the scan session, which reports
`Protocol::Modbus` too — so from then on the app's "current Modbus device" is the
sweep, not the poller. The frontend latches the last non-sweep Modbus target, and
the poll switch addresses that latch rather than the current session, so it does
not start driving the sweep it is sitting beside. Sweep-vs-poller is decided by
`ActiveSessionInfo.source_type` (`"modbus_scan"`), carried onto `Session` by the
roster reconcile. The `m_scan` id prefix survives only as the fallback for the
beat between minting the scan session and the first reconcile.

**A broker session tells the truth about having stopped.** The gate reads
`isStreaming`, so the backend has to be honest about when a session stopped
running, and it was not: `IOBrokerSource.state` was set `Running` at start and
never written again, and `StreamEnded` rides the *session* channel. A Modbus
source with no poll groups ends within a millisecond of session creation —
reliably *before* the frontend subscribes to that channel — so the push was
missed and the state went on saying "running" forever.

Two pieces close it, and neither is a new event. `SourceLifecycle`
([`io/lifecycle.rs`](../src-tauri/src/io/lifecycle.rs)) is a terminal-state slot
stamped by a `Drop` guard the merge task holds for its life — a guard rather than
an explicit store, because `run_merge_task` also returns early when settings fail
to load, and a flag written at one of two exit points is exactly the hole this
closes. Taking a guard also clears the previous ending, so "a new run is
starting" cannot be forgotten separately from "this run has one". `state()` reads
through it. Then `registerSessionSubscriber`'s reported state is adopted by the
multi-source create and join paths, which had been discarding it: registration is
the first moment a subscriber exists, so its answer is the one that cannot be
missed. A push nobody is listening for wants a pull at the point of listening,
not a second broadcast.

Three more sources had the same shape and now use the same primitive: the Modbus
scan source, MQTT and gs_usb each spawn a detached task and left `self.state` on
`Running` forever. `CaptureSource`'s `completed_flag` is deliberately *not*
folded in — `start()` reads it to choose resume-vs-restart, so it is not purely a
terminal-state slot — and neither is `fatal_error`, which carries a message
rather than a state.

⚠ **It is opt-in, and three sources have not opted in**: `modbus_tcp::reader`,
`modbus_rtu::reader` and `virtual_device` all spawn detached work and return a
bare `self.state`, so they can still report `Running` after their task has ended.
Adoption is four mechanical edits (field, `new`, `guard()` at start, `state_or`
in `state()`), which is exactly the "a rule applied at N call sites" shape — the
end state is one `SourceState` every `IOSource` holds, so a source cannot keep a
bare `IOState` that lies. The register carries the entry.

**Per-source pause is readable, so nothing has to remember it.** The broker owns
`source_pause_flags` (the merge task still creates each flag, into the shared
map), `IOSource::paused_source_profile_ids()` reports them, and
`ActiveSessionInfo` carries the list. `pause_source_polling` and
`resume_source_polling` broadcast a `SessionLifecycle` event with event type
`"updated"`, because `useSessionRosterSync` re-fetches on a lifecycle push, on
mount and on reconnect — and on nothing else. `useModbusPollControl` reads the
store, so two panels on one session agree and a reload comes back correct; it
used to hold `isPolling` as optimistic React state because there was nothing to
read.

That also makes the sweep guard checkable. `endpoint_in_use_by_poller` excludes
the caller's `target_session_id` only when `stop_target` is set; it used to do so
unconditionally, on the caller's word. Note that "is it paused?" is *not* the
test that earns the exemption — a paused poller keeps its socket, which is why
`holds_socket` counts it. `resume_source_polling` carries the mirror check
against `scan_holding`.

---

## 4. Rust session lifecycle

A session is an `IOSession` stored in the global `IO_SESSIONS` HashMap in
[src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs). Each session owns a
`Box<dyn IOSource>` plus source config, profile bookkeeping, and capabilities. Its
subscribers are **not** stored on it — they live in the global `APP_REGISTRY` (see
[The open-app registry](#the-open-app-registry--subscribers--the-cross-window-roster)).

Every session eventually becomes a capture (or is torn down). Pause/Play control the
live view; the three **exit controls** in the session menu each end it differently:

```
  Leave session    one app detaches and reviews a frozen capture snapshot;
                   any other apps on the session keep streaming live
  Stop session     the shared source stops → every connected app reviews the
                   same capture
  Destroy session  the session is torn down → every connected app → No Source
```

### App cleanup on teardown — `onBeforeWatch`

`onBeforeWatch` is the app's "drop whatever is on screen" hook. Despite the
name it fires on **acquiring and releasing** a source — every path that changes
what the app is showing calls it, including `handleDestroy`, `skipReader`
("Continue without a source") and the `leave()`→disconnect branch.

Two rules, both learned from stale frames surviving a teardown:

- **Clear locally; don't wait for the round trip.** `handleDestroy` and
  `skipReader` invoke it directly rather than relying on the `destroyed`
  lifecycle event. That event only arrives while the listener for *that*
  session id is mounted, so anything changing the effective session id
  mid-teardown used to strand the view on a dead session's data. `stopWatch` is
  the deliberate exception — stop switches to capture replay, so the picker and
  selection must survive.
- **Drop callbacks before any `await`.** `useIOSession.leave()` calls
  `clearCallbacks` first, then marks the subscriber inactive in Rust. The
  reverse order leaves a window the width of an IPC round trip during which
  queued WS frames still reach the app and repopulate what it is clearing.

Apps should make their reset a single store write. Discovery's
`resetDiscoveryView` calls `clearAll()` for exactly this reason: clearing
frames and the frame picker separately produces a render in between where rows
exist but the picker already reads 0/0.

**A reset only ever applies to one session.** Registering on a new session makes
Rust tear the old one down (`teardown_session_if_empty(prev, true)`,
[io/mod.rs](../src-tauri/src/io/mod.rs)) and broadcast `destroyed` with
`reset: true`. That event lands a few milliseconds *after* the switch returned
and set the new session id, and `useIOSession`'s lifecycle listener is
registered per session id behind an `await listen(...)` — so the departing
session's listener is still live to receive it. Left alone, the old session's
teardown reset the one just joined: a Modbus sweep used to land the app on
"No source" with its results tab gone.

`useIOSession` therefore keeps `abandonedSessionRef` — the session this hook
moved off — and a `destroyed` naming it gets the store cleanup but never reaches
`onDestroyed`. **`markSessionSwitch` is what stamps it, and every path that
moves an app to a different session must call it before the backend call**,
because the registration is what triggers the old session's teardown.
`reinitialize` stamps for itself, which covers watch, load, connect-only and
jump-to-bookmark in one place; `useIOSessionManager` stamps the two that bypass
it (`startMultiBusSession` and `joinExistingSession`). `selectProfile` needs no
stamp — it sets the profile and lets the effect re-register the listener before
`openSession` runs.

The ref names the session *left*, not the one held, so a path that never stamps
degrades to the old behaviour rather than stranding the app on a session that is
genuinely gone.

### Leave session — per-app detach to a snapshot

`handleLeave` ([useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts)) calls the
Rust `session_leave_to_capture` command; the heavy lifting is in
`detach_subscriber_to_capture_copy` ([io/mod.rs](../src-tauri/src/io/mod.rs)):

```
App clicks Leave (realtime/recorded; other apps may share the session)
     │
     ▼
session_leave_to_capture(session_id, subscriber_id)      src-tauri/src/io/mod.rs
     ├─ copy_capture(frame capture) → orphaned snapshot "{capture}_{n}"
     ├─ unregister_subscriber(this subscriber only)
     │     └─ session stays alive if other subscribers remain;
     │        destroyed via the last-subscriber teardown if not
     └─ emit `subscriber-evicted { session_id, subscriber_id, capture_ids }`
                   │
                   ▼
        Only the leaving app's useIOSession receives the event →
        onDestroyed(capture_ids, /*userInitiated*/ false) →
        handleSessionDestroyed switches THIS app to the snapshot replay.
        Any other apps are untouched and keep streaming the live source.
```

The snapshot is a frozen copy — the live session keeps its own capture. Opening the
live capture directly as a replay is deliberately *not* used: `CaptureSource::new`
re-owns (steals) the capture, which would stop the remaining apps persisting frames.
The same `detach_subscriber_to_capture_copy` core backs the Session-Manager's forced
**evict** (it labels the copy `(evicted)` instead of `_{n}`). In capture-replay mode
there's nothing live to leave, so Leave is a plain `session.leave()` disconnect to No
Source. If there are no captured frames, the copy is empty and the app simply returns
to No Source.

### Stop session — stop the shared source for all apps

The **Stop session** control (`stopWatch` → `session_stop_to_capture`) switches the
*whole* session to capture replay in place, so every connected app reviews the same
capture. The realtime-vs-recorded decision and its fallbacks live in Rust: a
**realtime** source stops and switches all listeners to capture (falling back to a
plain `suspend` if no capture exists); a **recorded** source `suspend`s (preserving
position) then switches to capture replay. It emits a scoped `session-lifecycle` so
every subscribed app transitions together (`onSwitchedToCapture`); the frontend just
calls the one command.

### Destroy session (recovery)

The session menu also has a destructive **Destroy session** item for recovering
from a wedged session. It calls `destroy_reader_session(reset: true)`, tearing
down the backend session for *all* subscribers. The deliberate-destroy intent is
carried by Rust in the emitted `session-lifecycle "destroyed"` event (a `reset`
flag on `SessionLifecyclePayload`); the per-app cleanup (`handleSessionDestroyed`)
reads it and resets to **No source** instead of switching to the orphaned capture
(the external-destroy fallback, `reset: false`). Rust owns the intent — there is
no frontend shim.

### The open-app registry — subscribers & the cross-window roster

Subscribers are **not** stored on the `IOSession`. A single global `APP_REGISTRY`
([io/mod.rs](../src-tauri/src/io/mod.rs)) is the source of truth for every open
session-aware app instance across **all** windows. Each `AppInstance` carries its
`instance_id`, a cosmetic `display_id` (`appName_<rand>`, for the UI), its owning
`window_label`, and a single `session_id: Option<String>` — `None` = the panel is
open but not watching, `Some(sid)` = attached to that session. Because the
attachment is one `Option`, the **one-subscriber-one-session** invariant holds by
construction: attaching to a session simply overwrites the field.

The per-session subscriber list/count the rest of the system reads (e.g.
`ActiveSessionInfo.subscribers`, the wake-lock, the joiner count) is **derived**
from the registry via `subscribers_for_session` / `subscriber_count_for_session`.
The `IOSession` keeps no `subscribers`/`joiner_count` field.

Instance ids are deterministic — `${windowLabel}_${appName}` (one session-aware
app per window). The same id is the registry key, the session subscriber id, and
the value `useIOSession` registers, so an open panel and its session attachment
are the same entry.

**Registration is Dockview-driven, attachment is `useIOSession`-driven:**

- `MainLayout` registers/unregisters an open-app from Dockview's
  `onDidAddPanel`/`onDidRemovePanel` (`register_app` / `unregister_app`). This
  fires for **every** session-aware tab — including ones Dockview hasn't mounted
  yet — so a never-activated panel still shows in the graph.
- When the panel watches a source, `register_subscriber` → `attach_app` sets the
  entry's `session_id`; leaving (`unregister_subscriber` → `detach_app`) clears it
  back to `None` (the panel is still open). These run inside the existing join/leave
  commands — no new frontend calls.

**Teardown** still fires when a session's **last** subscriber leaves: every path
that can empty a session (`unregister_subscriber`, the attach-elsewhere move in
`register_subscriber`, panel unmount via `unregister_app`, and window close via
`prune_window_sessions`) calls the shared `teardown_session_if_empty`, which checks
`subscriber_count_for_session == 0` and runs `destroy_extracted_session` (stop
source, orphan capture, `session-lifecycle "destroyed"`). The attach-elsewhere move
is the backstop for a frontend leave that loses a race when an app switches sources
— because the rule lives in Rust under the locks, no frontend timing can orphan a
session.

**No registry entry outlives its session.** Every teardown path calls
`detach_all_from_session`, which clears `session_id` on every instance pointing at
the session being destroyed (keeping the instances — their panels are still open).
`destroy_session` does this too, and unconditionally, since a stale attachment must
go even when the session had already been removed. This is load-bearing, not
hygiene: the subscriber count is *derived*, so a leftover entry reports a phantom
subscriber, and it becomes the `prev_session_id` that the next `register_subscriber`
evicts and tears down all over again.

**`reset` distinguishes a deliberate move from an external death.** It rides the
`destroyed` event: `reset: false` tells apps to fall back to the session's orphaned
capture, `reset: true` tells them to return to "No source". Teardown paths pass it
according to intent — the attach-elsewhere eviction and the same-id recreate in
`create_multi_source_session` pass `true` (the subscriber chose a different session,
or the session is about to come straight back), while a plain leave, a panel unmount
and a window close pass `false`. Getting this wrong is what turned one teardown into
a loop: adopting the orphaned capture makes that capture id the app's *next session
id* (`effectiveSessionId = multiSessionId ?? ioProfile`), which re-enters the same
teardown and mints a fresh capture every hop.

**Cross-window roster.** Any registry mutation calls `emit_open_apps_changed`,
which broadcasts exactly like `session-lifecycle`: a Tauri `app.emit("open-apps-changed", …)`
**and** a WS channel-0 `OpenAppsChanged` (0x17). Each window reconciles its
`openAppsStore` from `list_open_apps()` on that broadcast (and on WS reconnect) via
`useOpenAppsSync` — mirroring how `useSessionRosterSync` reconciles sessions. The
Session Manager "Visual" graph sources its app nodes from this store, so it shows
apps from every window (connected nodes where `session_id` is set, unconnected where
it is `null`). When a window closes, `on_window_event`'s `Destroyed` handler calls
`prune_window_sessions(label)` to drop that window's instances and cascade any
last-subscriber teardown.

Windows are surfaced to the user by `formatWindowName`
([src/utils/windowName.ts](../src/utils/windowName.ts)): the primary window
(internally labelled `dashboard`) shows as `main`, and dynamic `main-N` windows
show as `N` (in App Details and the OS title bar).

### Play / Pause

Play and Pause are items in the session menu (opened by clicking the session chip).
- **Realtime running** → Pause calls `session.pause()`.
- **Realtime paused** → Play calls `session.resume()`.
- **Capture paused** → Play starts forward playback.
- **Capture running** → Pause pauses playback.

### RESUME to live

`resume_session_to_live` rebuilds the original `IOBroker` from the
stored `source_configs`, calls `profile_tracker::can_use_profile()` for each,
and then uses `replace_session_source(..., auto_start=true)` to swap in the
live reader.

### Capture labelling during streaming

Rename and Pin are session-menu items available whenever capture metadata exists —
including during realtime streaming. Renaming a capture automatically pins
it (marks it persistent). The Speed item is always present but disabled
(greyed) for realtime sessions where speed control is not supported.

### `replace_session_source` — the shared primitive

All three transitions (stop→capture, capture→live, recorded→capture replay) go
through [`replace_session_source`](../src-tauri/src/io/mod.rs):

1. Stop old device (idempotent — no-op if already stopped).
2. Record old device type.
3. Swap `session.source = new_device`.
4. Update `source_names` / `source_configs` if provided.
5. Clear `suspended_at`.
6. Optionally `start()` the new device.
7. Emit a `session-lifecycle` scoped message containing the new state and
   capabilities so all subscribers pick up the change.

It takes `&mut HashMap<String, IOSession>` rather than the lock itself, so
callers can hold `IO_SESSIONS` across their full operation and avoid
double-locking.

---

## 5. WebSocket transport

Frame delivery and most session events flow over a local WebSocket, not
Tauri events. The server is started during Tauri `setup()` in [lib.rs:945](../src-tauri/src/lib.rs#L945)
and binds to `127.0.0.1:0` (ephemeral port). The frontend fetches the port
and auth token via the Tauri command `get_ws_config` and connects once at
startup through [src/services/wsTransport.ts](../src/services/wsTransport.ts).

### Binary protocol

Each message is a 4-byte header + payload ([ws/protocol.rs](../src-tauri/src/ws/protocol.rs)):

```
┌──────────┬──────────┬──────────┬──────────┬─────────────────┐
│ version+ │ msg_type │ channel  │ reserved │    payload      │
│  flags   │          │ (1 byte) │          │                 │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
  1 byte     1 byte     1 byte     1 byte       variable
```

Channels 1–254 are allocated per subscribed session (one channel per
`sessionId`). Channel 0 is the global broadcast channel for app-wide events.

### Message types

Per-session (channel 1..254):

| MsgType | Value | Purpose |
|---------|-------|---------|
| `FrameData`         | 0x01 | Binary batch of `FrameEnvelope` records |
| `SessionState`      | 0x02 | IO state change (stopped/starting/running/paused/error) |
| `StreamEnded`       | 0x03 | Stream finished with reason + finalised capture info |
| `SessionError`      | 0x04 | Error string |
| `PlaybackPosition`  | 0x05 | timestamp_us / frame_index / frame_count |
| `DeviceConnected`   | 0x06 | A source inside a multi-source session connected |
| `CaptureChanged`    | 0x07 | Capture created/orphaned; frontend re-fetches |
| `SessionLifecycle`  | 0x08 | State + capabilities inline; covers device-replaced, resuming, switched-to-capture |
| `SessionInfo`       | 0x09 | Speed, subscriber count |
| `Reconfigured`      | 0x0A | Session was reconfigured (time range, bookmark) |
| `DecodedSignals`    | 0x14 | JSON batch of decoded signals, pushed alongside `FrameData` when a catalogue is attached (see [§ Decoded-signal stream](#decoded-signal-stream)) |
| `FrameCounts`       | 0x16 | Live total + distinct-(bus,frame_id) unique counts, pushed on the frame cadence (see [§ Frame counts](#frame-counts)) |
| `ByteCounts`        | 0x19 | Live raw-byte total + the session's byte-capture id, pushed on the byte cadence (see [§ Raw serial bytes](#raw-serial-bytes--counted-not-streamed)) |
| `ModbusScanState`   | 0x1A | Discovery sweep progress + device identification, throttled to 2 Hz (see [§ Modbus discovery](#modbus-discovery)) |

JSON-payload session messages go out through
[`send_session_json`](../src-tauri/src/ws/dispatch.rs), which resolves the
channel, serialises only once a subscriber is known to exist, and drops silently
otherwise — the same contract as every other session sender.

Global (channel 0):

| MsgType | Value | Purpose |
|---------|-------|---------|
| `SessionLifecycle`  | 0x08 | Created / destroyed (broadcast to all clients) |
| `TransmitUpdated`   | 0x0B | Transmit queue changes |
| `ReplayState`       | 0x0C | Replay controller state |
| `TestPatternState`  | 0x0D | Test Pattern run state (counters, sweep rows, peer) — payload is the whole `IOTestState` |
| `OpenAppsChanged`   | 0x17 | Open-app roster changed; clients re-fetch `list_open_apps` (see [§ The open-app registry](#the-open-app-registry--subscribers--the-cross-window-roster)) |
| `CatalogListChanged`| 0x18 | Decoder-catalogue list changed (mutation, decoder-dir change, or filesystem watcher); clients re-fetch `list_catalogs` from the warm backend cache (see [§ Catalogue list cache](#catalogue-list-cache)) |

Control frames: `Subscribe` / `Unsubscribe` / `SubscribeAck` / `SubscribeNack`,
plus `Heartbeat` and `Auth`. Request/response RPC uses `Command` (0x20) /
`CommandResponse` (0x21) with a correlation id — the `catalog.*` ops below ride
this.

### Decoded-signal stream

Catalogue decoding is done **once, in Rust**, by the shared
[`wiretap-catalog`](../../wiretap-lib-rs) crate — the frontend no longer
re-decodes every frame. Two surfaces, both over this WebSocket:

- **`catalog.*` commands** (request/response via `Command`/`CommandResponse`,
  dispatched in [catalog.rs](../src-tauri/src/catalog.rs) `dispatch_catalog_command`):
  - `catalog.parse` — TOML → resolved `Catalog` model (CAN/Serial/Modbus;
    shorthands + mirror/copy resolved)
  - `catalog.validate` — TOML → `{ valid, errors[] }` (field-path + message)
  - `catalog.import_dbc` / `catalog.export_dbc` — DBC ↔ catalogue TOML
  - `catalog.attach` `{ session_id, content, path? }` — parse + bind a catalogue to
    a session, **returning the resolved `Catalog`** so the caller builds its UI
    model from that one parse; the optional `path` is recorded as the session's
    authoritative decoder path (see below). `catalog.detach` `{ session_id }` — unbind
- **`DecodedSignals` push** (0x14): while a catalogue is attached,
  `send_new_frames` decodes the same batch via `decode_by_id` (applying
  `frame_id_mask`) and pushes a parallel JSON message
  (`[{ frameId, bus, t, bytes[], signals[], selectors[], headerFields[], sourceAddress, mirror?, tunnel? }]`).
  Each entry carries `bytes` — the raw payload decode ran on — so the Decoder can
  render a hex/ASCII byte row **per mux value** (stored as `rawBytesByMux`); the
  frame-level `rawBytes` from the `FrameData` path is last-writer-wins, so a
  multiplexed frame would otherwise show one mux occurrence's payload under every
  group.
  `sessionStore` routes it to an `onDecoded` callback (threaded through
  `useIOSession`/`useIOSessionManager`); an app calls `catalog.attach` when it
  loads a catalogue. Because `send_new_frames` only decodes frames *past* a
  forward-only per-session send offset, `catalog.attach` also re-decodes the frames
  already delivered to the client (`redecode_delivered`) and pushes their signals —
  otherwise a catalogue bound *after* a capture replay had already streamed its
  frames (e.g. the per-app Leave switching the decoder to a fresh replay session)
  would leave them showing "No signals decoded". Raw `FrameData` keeps flowing for
  Discovery/Analysis/raw-hex/Calculator. **Decoder and Graph** both
  consume the decoded stream — there is no longer a TypeScript decode engine.
  Attachments auto-detach on final unsubscribe.
  The decode forks by register bank: a Modbus coil or discrete frame's block
  is packed bits, so the catalogue's byte and word order do not apply to it
  and neither does a signal's override of them.

### Tunnelled protocols

Some devices carry a whole other protocol inside one CAN id. A Sungrow SBR's
`0x1E0` is a **Modbus RTU byte stream**: payloads concatenate, a message longer
than 8 bytes is split across consecutive frames (a 17-byte response arrives as
8+8+1), and the inverter's request and the BMS's reply share the id. There is no
transport header — no sequence number, no length prefix, no first/consecutive
distinction — so boundaries come from the RTU length rules alone, gated by
CRC-16/Modbus.

A catalogue declares it on the frame:

```toml
[frame.can."0x1E0".tunnel]
protocol = "modbus_rtu"
device_address = 1                    # optional; absent = sync on any address 1..=247
vendor_functions = [0x20, 0x60, 0x65] # optional; codes the RTU length rules do not model
allow_broadcast = true                # optional; lets address 0 start a message
```

Reassembly is `wiretap_catalog::modbus_rtu_stream::ModbusRtuStream`, held in
`ws/dispatch.rs` as `TUNNEL_DECODERS` beside `MIRROR_TRACKERS` and built at
`catalog.attach`.

**It is also the serial port's framer.** There used to be a second, weaker RTU
implementation in `io/serial/framer.rs`: it tried every length from 4 upwards and
took the first CRC hit, so a short prefix that coincidentally validated beat the
real message, and it dropped a byte whenever nothing validated, eating the head
of a split message before its tail arrived. `FramingEncoding::ModbusRtu` now
constructs a `ModbusRtuStream`, so a message framed off a serial port and one
recovered from a tunnelled CAN id are framed by identical rules. Three entry
points, one set of rules — `push` counts frames (a CAN payload is a slice of the
stream), `push_bytes` does not (a serial line has no frames to count), and
`interpret` takes a boundary somebody else already found.

The last copy of that brute-force scan lived on in the frontend, behind
Discovery's Serial Framing tool, until it too was replaced —
`framing_detect.rs` now scores every mode by running the framer that would
actually read it, off the capture store rather than a 100 KB copy shipped to the
frontend. It also reports what it could *not* frame — the function codes, and
how many address-0 messages — which is what makes the two opt-ins below usable
without knowing the answer first, and *Apply* on that result declares them. The
hint's gap search admits address 0 even when the framer does not: an undeclared
broadcast swallows the messages behind it, so a hint that could not see one
would tell you to declare the codes and leave you with half the line.

**A line is not obliged to be stock Modbus.** `ModbusRtuOptions`
(`io/types.rs`) carries the whole RTU configuration — device address, CRC
policy, vendor function codes, broadcast — and builds the stream from it. Vendor
codes and broadcast are opt-in from two independent places that **union**: the
catalogue's `[…tunnel]` table above says what the *device* carries, and the
picker's framing options say what *this session* wants framed. Both default off,
because guessing at either is how a framer invents messages out of noise.

A serial session publishes its resolved options to `ws/dispatch.rs` via
`set_serial_rtu_options`, keyed by session and cleared in `detach_catalog`. That
is not optional: `interpret` rejects an unmodelled function code outright, so
without the same declaration a vendor message would be framed correctly on the
wire and then dropped before it reached the Modbus tab. The device-address
filter is *not* re-applied there — that one is subtractive and the framer has
already applied it, where the vendor list is additive.

**A serial port reaches the Modbus tab too**, through that third entry point.
The reader has already framed the port, so each frame is one whole message and
there is nothing to reassemble — `feed_tunnels` calls `interpret` instead of
`push`, and everything downstream is shared with the tunnel path. What opens it
is the attached catalogue's protocol being `modbus`: a serial catalogue leaves
`SessionTunnels.serial` as `None`, so some other serial framing that happens to
parse as Modbus is never reported as a message. The stream is still kept per
session and per bus, because a read response carries no register address and
inherits it from the request before it. Two consequences worth knowing: the tab
needs a catalogue attached, like the tunnel path does, and because the verdict
is recomputed from the stored bytes it is the same live or replayed — which is
why the framer's `crc_valid` is not persisted.

`interpret` also gates on `is_plausible` when the CRC disagrees, the same bar
`CrcPolicy::Lenient` sets for a boundary it guessed. Without it any five bytes
opening like an address and a read function code would be reported as a response
carrying no registers.

Four things about it differ from every other decode:

- **It is order-dependent.** `encode_decoded_batch` feeds a tunnel frame
  *before* the "skip frames that decoded nothing" filter — a skipped frame is a
  hole that desyncs every message after it. `reset_frame_offset` and
  `redecode_delivered` drop the buffers for the same reason `MirrorTracker`
  resets there: a stream fed the same bytes twice, or fed a rewind mid-message,
  desyncs.
- **One buffer per `(bus, frame id)`, not per id.** A multi-bus capture carries
  the same tunnel id on each bus and those are separate serial lines. On a
  two-bus SBR capture, sharing one buffer loses 3 of 499 responses; a buffer per
  bus recovers all 499 with no unconsumed bytes.
- **A message rides the frame that *completed* it**, so its timestamp is when
  the exchange became readable, and `tunnel[].frames` says how many frames it
  spanned.
- **Rendering is capped** at `MAX_RENDERED_TUNNEL_MESSAGES` (500, mirroring the
  frontend's `MAX_TUNNEL_TRANSACTIONS`). The reassembler still sees every frame;
  only the newest messages are serialised. Without it `redecode_delivered` over
  a long capture builds a message nobody reads — one 1M-frame capture completes
  47,562 exchanges at roughly 1 KB of JSON each.

Interpretation is `ws/tunnel_signals.rs`. Each message yields:

- **Signals**, so a tunnelled register reaches the signal table, graphs and
  dashboards like any other. A register the catalogue describes decodes through
  the ordinary `decode::decode_frame` path — factor, offset, word order, enums —
  found by `Catalog::modbus_register_frame`, which filters on protocol (`frame()`
  matches on `frame_id` alone, so CAN `0x1E0` and Modbus register 480 are
  otherwise the same lookup) and resolves `register_base`. Uncatalogued registers
  fall back to `Modbus_{Request,Response}_Value_N`, so a tunnel is readable
  before anyone has mapped it.
- **A transaction record** (`tunnel[]` on the entry) — direction, function,
  register, values, CRC verdict, the reassembled bytes — which drives the
  Decoder's **Modbus** tab. `applyDecodedBatch` also keeps the last complete
  message *per direction* on the decoded frame (`tunnelBytes`), because **Show
  raw bytes** would otherwise render the frame-level payload — one ≤8-byte slice
  of the stream, and for a response split across three frames whichever fragment
  arrived last (on `0x1E0` that is the single byte `8A`). The Signals tab shows
  those two messages instead, labelled by direction and uncoloured: the
  signal-to-byte colour map is index-aligned to the CAN payload and means
  nothing over a reassembled message. That tab exists because the catalogue declares a
  tunnel, not because messages have arrived, so it is there on a quiet bus and
  survives *Clear decoded*.

Request and response share one id, so the synthesised signals carry the
direction in the name (`Modbus_Request_Register`, `Modbus_Response_Function`) —
in a store keyed by name the response would otherwise silently replace the
request. An earlier cut grouped them with a synthetic `muxValue` instead; the
signal table renders a mux group as **"Mux 9 (0x9)"** and swaps the frame-level
byte row for that group's payload, which for a message rebuilt from three frames
is simply the wrong bytes. **A frame that is not multiplexed must not claim to
be** — the MCP `decoder.signals` surface reports selectors too.

Registers are catalogued as ordinary `[frame.modbus.*]` entries in the same
file, `disabled = true` so the Modbus poller never drives what the tunnel only
observes.

### Mirror validation

`mirror` rides the same 0x14 entry, on mirror frames only —
`{ sourceFrameId, isValid, timeDeltaMs, mismatchedByteIndices[] }`. Absent means
"not a mirror"; `isValid: null` means no comparison has run yet.

State is a `wiretap_catalog::mirror::MirrorTracker` per session, held in
`ws/dispatch.rs` beside `ATTACHED_CATALOGS` and **built at `catalog.attach`,
dropped at `catalog.detach`** — so a verdict, and the inherited byte set behind
it, can never outlive the catalogue that produced it. (It used to live in
`decoderStore` and was never cleared: a latched Mismatch survived catalogue
reload, session restart, replay and clear-frames until the window was reloaded.)
`reset_frame_offset` also calls `MirrorTracker::reset` — same moment, same
meaning: without it the retained samples re-assert a verdict the user just
cleared, and after a replay rewind the timestamps sit outside the fuzz window
so it could never be compared away.

The tracker is an `Arc<Mutex<_>>` in the map for the same reason
`ATTACHED_CATALOGS` holds an `Arc` — the per-batch work happens outside the
map's lock, so one session's frames never block another's. It reads the
frame-id mask once at construction, so the streaming path never touches the
catalogue and cannot be paired with the wrong one.

Three rules the comparison depends on:

- **Only inherited bytes are compared.** A signal the mirror declares at the
  same `start_bit:bit_length` as its source *overrides* the inherited one
  (`parse::resolve_mirror_inheritance`) and drops out of the comparison — that
  is how a catalogue says "this byte is legitimately different here", as
  `sbrxxx.toml` does for `0x504`'s sign-inverted current and `0x005`'s
  end-stop flag.
- **Every delivered frame is observed**, before the filter that skips frames
  with nothing decoded. A mirror can only be judged if its source is seen too,
  and the source may carry no signals the view asked for. This replaced a
  frontend force-include (`sourceIdsForValidation`) that pushed unselected
  mirror sources through the decode path just to keep the comparison fed.
- **A mirror with no inherited bytes is not tracked at all.** An inherited mux
  is copied wholesale and its case signals carry no per-signal inheritance flag,
  so a mirror of a mux-only frame (`sbrxxx.toml`'s `0x008`/`0x00a`) inherits an
  empty set. Since an empty mismatch set means "all compared bytes agree", such
  a frame would otherwise show an unconditional green **Match** for a check that
  never ran — `MirrorTracker::new` skips it so the badge shows nothing instead.

A comparison runs only when the two samples are within the source frame's
catalogue interval (else `[meta.can].default_interval`, else 1000 ms) **× 2**;
outside that the previous verdict stands. Three consecutive failing comparisons
latch invalid — one differing sample is usually skew on a moving signal.

The offline equivalents (`db_query_mirror_validation`,
`capture_query_mirror_validation`, and the `apiclient` passthrough) take a
`compare_byte_indices` argument carrying the same inherited byte set, so the
Query app agrees with the Decoder's badge. Omitted or empty, they compare the
whole payload — the right answer for a caller with no catalogue.

Decoding lives entirely in the crate, and so does parsing: the frontend's
`catalogParser.ts` no longer parses TOML — `loadCatalog` calls `catalog.parse`
(Rust) and *adapts* the resolved `Catalog` to the legacy `ParsedCatalog` shape
(camelCase → snake_case) for the Decoder/Graph/Query in-memory models. The
serial header byte-positions (`frame_id_*`, `source_address_*`, `header_fields`)
are derived in the crate at parse time (v0.6.0+), so the adapter just renames
them rather than re-deriving from masks. The Catalog Editor keeps its own TOML
parser ([apps/catalog/toml.ts](../src/apps/catalog/toml.ts)) for round-tripping edits.

For a session-bound app, loading a catalogue parses it **once**: the
[`useSessionCatalog`](../src/hooks/useSessionCatalog.ts) hook (used by Decoder and
Graph) mirrors the session's `catalogPath` into local state, then `attachAndResolve`
(`catalogParser.ts`) calls `catalog.attach` and adapts the returned `Catalog` — so
the same parse binds Rust decode *and* builds the UI model (it falls back to a
model-only `loadCatalog` if attach fails).

The session's `catalogPath` is **Rust-authoritative**: `attachAndResolve` passes the
file path to `catalog.attach`, which records it; `list_active_sessions` reports it as
`catalog_path` and `reconcileKnownSessions` adopts it one-way. Apps mirror it into
local state but must **never write it back** — the dashboard loader doing so (in
`applyParsedCatalog`) raced the mirror into a ~50 ms attach/reload loop.
`setSessionCatalogPath` remains an optimistic local echo that the next reconcile
confirms.

**Bind only what the session has settled on.** The attach effect keys off
`sessionId`, but on a source switch `catalogPath` still holds the *previous*
source's catalogue for the render or two before the new session's own is decided
(`sessionCatalogPath` is `undefined` until the session reaches the store and `null`
until auto-select resolves it). Attaching in that window binds a catalogue the
session immediately disowns — and because the attach writes Rust's authoritative
path, which returns through the roster into the mirror, the two values then chase
each other: the visible symptom is a decoder flickering between the old catalogue
and the right one, with the unmatched list filling from the mismatched protocol.
The effect therefore returns unless `sessionCatalogPath === catalogPath`, letting
the mirror bring them into agreement first. Note this is a narrowing, not a cure:
a session's catalogue path is still written from a dozen call sites *and* adopted
from Rust, so two writers can still disagree — the durable fix is a single writer.

Modbus is handled by the Decoder
itself (there is no separate Modbus app): when a Modbus catalogue is involved the
Decoder fetches its poll groups — built in Rust (`catalog.polls`, surfaced on the
resolved catalogue by `catalogParser.ts`; the single source of truth shared with
the MCP/headless open flow) — *before* the watch, via an awaited `onBeforeStart` in
the IO picker that pre-loads the catalogue so the session is created **with** polls in
a single connection (rather than starting pollless and reconnecting, which broke
single-connection devices). A catalogue change mid-stream reinitialises the same
session id with the new polls.

**One-step decoder from the Data Source picker.** The picker
([IoSourcePickerDialog.tsx](../src/dialogs/IoSourcePickerDialog.tsx)) has a Decoder
footer that attaches a catalogue *as the session is created*: the chosen path rides
through `LoadOptions.catalogPath` and `useIOSessionManager` sets it on the new
session via `setSessionCatalogPath` (the cross-app channel), so a decode-aware app's
`useSessionCatalog` mirror then binds it — no second step. The footer is seeded
from the host app's currently loaded catalogue, but the selected source's
`preferred_catalog` **overrides that seed** rather than filling only an empty slot:
the seed is just the previous source's decoder, so the older rule showed a Modbus
decoder for a CAN source and never offered that source's own. A manual pick or
clear still wins (`decoderUserTouched`). When the chosen catalogue declares serial
framing the picker parses it (`loadCatalog`) and reflects that encoding in the
source's framing dropdown, so the framing is explicit before connecting.

**Auto-select from `preferred_catalog`.** When a session is created *without* a
catalogue, the decode-aware apps (Decoder, Dashboard, Query) auto-select one from
the source profile's `preferred_catalog` — building an absolute path with
`buildCatalogPath(preferred, decoderDir)` and setting it via `setSessionCatalogPath`.
The effect waits for `decoderDir` to resolve from settings before running: an empty
dir yields a bare filename, `open_catalog` reads the path verbatim (no dir
resolution) so the attach fails, and the effect's own "already set" guard would then
stop it ever re-running — leaving the session undecoded until a manual pick. Distinct
from the catalog *list* read (which `list_catalogs` resolves dir-side and so does not
gate on `decoderDir`).

**Live serial reframing.** Serial framing (SLIP/Modbus-RTU/delimiter) is applied
by the backend read loop ([io/serial/reader.rs](../src-tauri/src/io/serial/reader.rs)),
so a source connected *before* its catalogue starts in `Raw` mode — raw bytes, no
frames, nothing to decode. Selecting a serial catalogue mid-stream calls the
**`io_set_framing`** command ([transmit.rs](../src-tauri/src/transmit.rs)), which
swaps the running source's framer **in place** via a per-source control channel
(`SourceMessage::ControlReady`, mirroring the transmit path) — same session, no
device reopen, and the attached catalogue keeps decoding (no re-attach). The broker
records a framing override so `combined_capabilities` flips `rx_frames` true (pushed
as a `SessionLifecycle` update), and creates a frame capture on demand (a bytes-only
session has none) so the now-framed messages land, stream and decode. The Decoder
calls it from [`useSessionCatalog`](../src/hooks/useSessionCatalog.ts)'s sibling
serial-config effect when the encoding first appears, falling back to a full
re-watch if the live swap fails.

**Modbus RTU framing is CRC-gated, and `validate_crc: false` is a lenient mode,
not "no framing".** RTU has no delimiter — a message boundary is only knowable
from the per-function-code length rules plus the CRC that confirms them, so the
old "don't validate" path could not frame at all and emitted fixed four-byte
chunks. It now maps to `CrcPolicy::Lenient`: boundaries still come from the
length rules, and where strict framing would give up and drop a byte, lenient
emits the longest *structurally plausible* candidate flagged `crc_valid: false`.
Plausibility is what the wire format guarantees independently of the CRC — a
byte count that matches the quantity it claims, an exception code that exists —
so a real message is never rejected, and line noise cannot fabricate one from
every byte pair that looks like an address and a function code. On a stream whose
CRCs are correct the two policies are identical. The flag is the honest part: on
a noisy line with no declared `device_address`, lenient *will* invent messages.

### Catalogue list cache

The decoder-picker list (what `list_catalogs` returns — the `.toml` files in
`decoder_dir`, distinct from the *attached* catalogue above) is **owned by the
backend**, not re-scanned per call. A `CatalogCache` in managed state
([catalog.rs](../src-tauri/src/catalog.rs)) is **warmed once during `setup`**
(`start_catalog_cache`, right after settings resolve), so the frontend's first
`list_catalogs` is served from memory — no startup race where the picker shows
empty until settings resolve, and no re-walking the directory (or re-logging
the duplicate-display-name warning) once per consumer.

The cache is kept fresh by `refresh_catalog_cache`, called when a catalogue
mutation command runs (`save`/`duplicate`/`rename`/`delete_catalog`), when
`decoder_dir` changes in `save_settings`, and — on desktop — by a `notify`
filesystem watcher on the decoder dir (debounced ~250 ms) that catches `.toml`
files added or edited outside the app. iOS has no watcher: it warms once and
refreshes only via the explicit mutation/settings paths.

Each rebuild signals every WS client with a global `CatalogListChanged` (0x18)
on channel 0 ([ws/dispatch.rs](../src-tauri/src/ws/dispatch.rs)
`send_catalog_list_changed`). The frontend's
[`useCatalogList`](../src/hooks/useCatalogList.ts) hook (Decoder, Dashboard,
Query, Catalog Editor) treats the push as a re-sync trigger and reconciles via
`list_catalogs` — fetching on mount, on each push, and on WS reconnect — exactly
the `useOpenAppsSync` pattern, keeping Rust the single source of truth. (The
modal pickers — `SaveFramesDialog`, `IoSourcePickerDialog` — still read
imperatively on open; they get the warm-cache benefit but not live updates.)

### Dispatch path

```
IOSource reader task
      │  SourceMessage::Frames
      ▼
IOBroker merge task
      │  sorts by timestamp, batches, writes to capture_store
      ▼
capture_store::append_frames_to_session(session_id, frames)
      │
      │  (reader also calls signal_frames_ready(session_id))
      ▼
signal_throttle.rs — SignalThrottle::should_signal()
      │  SIGNAL_INTERVAL_MS = 500  (2 Hz)
      ▼
ws::dispatch::send_new_frames(session_id)
      ├─ look up WS channel for session_id
      ├─ read new frames from capture_store since last offset
      ├─ encode_frame_batch → binary FrameEnvelope stream → FrameData (0x01)
      ├─ if catalogue attached: decode_frame batch → DecodedSignals (0x14)
      ├─ push live total + unique counts → FrameCounts (0x16)
      └─ send_to_channel
                    │
        ┌───────────┼────────────┬─────────────┐
        ▼           ▼            ▼             ▼
   Discovery    Calculator   (FrameData)   Decoder/Graph
   onFrames     raw bytes      raw          DecodedSignals (decoded in Rust)
```

The 2 Hz throttle lives in [io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs).
Readers write frames into the capture as fast as they arrive; `send_new_frames`
pulls from the capture and pushes to the WS channel at most twice per second.
`SignalThrottle::flush()` is called on stream stop so the final batch is
delivered immediately.

#### Raw serial bytes — counted, not streamed

A serial source in `Raw` mode (`emit_raw: true`, no framing encoding) fills a
`Bytes` capture instead of a `Frames` one. Its bytes take a deliberately
different path from the frame batches above:

```
IOBroker merge task
      │  capture_store::append_raw_bytes_to_session(session_id, bytes)
      │  signal_bytes_ready(session_id)   ← same SignalThrottle, key "bytes-ready"
      ▼
ws::dispatch::send_new_bytes(session_id)
      ├─ look up WS channel + the session's Bytes capture
      ├─ read the capture's O(1) total
      └─ encode_byte_counts → ByteCounts (0x19): total u64 + capture id
                    │
                    ▼
   sessionStore stores byteCount + bytesCaptureId on the session
                    │
                    ▼
   ByteView refetches rows from that capture — get_capture_bytes_tail while
   streaming, get_capture_bytes_paginated when stopped
```

`send_new_bytes` also runs on WS subscribe and when `ingest_bytes` appends under
a watching session — a capture that already holds its bytes never signals, so
without the subscribe push a session opened on one reported zero forever.

**Only the count crosses the wire.** One small message twice a second, whatever
the baud rate; the rows are read from the capture on demand. Streaming the bytes
themselves would tie WS traffic to link speed (a `FrameEnvelope` caps at 255
bytes of payload behind a 12-byte header) and would keep a second copy of data
the capture already holds durably. This is the same "capture is the display
source" contract the frames table follows — see
[capture-flow.md § The capture is the display source](capture-flow.md#the-capture-is-the-display-source).

Two consequences worth knowing:

- **`get_capture_bytes_tail` must not scan.** It is called on every count push,
  so it is `ORDER BY rowid DESC LIMIT n` with the total taken from the registry.
  Reinstating an `OFFSET total - n` there makes it quadratic over a session.
- **Readers coalesce their own fetches.** A fetch can outlast the 500 ms signal,
  so the byte view skips while one is in flight and runs once more on completion
  rather than queuing on the DB mutex ([ByteView.tsx](../src/apps/discovery/views/serial/ByteView.tsx),
  mirroring `useCaptureFrameView`).
- **The session is the only copy.** Discovery reads `byteCount` and
  `bytesCaptureId` off the session through `useIOSessionManager` and passes them
  down as props. `discoverySerialStore` used to mirror them and its own
  serial-mode reset wiped the mirror after the session had been written — a
  byte capture opened as a source showed "Waiting for serial data…" with the
  count sitting in the session store. Don't reintroduce a copy.

### Frame counts

Frame counts are **Rust-authoritative** — the frontend does not count. Each
capture maintains a running total (`metadata.count`) and an in-memory set of
distinct `(bus, frame_id)` keys ([capture_store.rs](../src-tauri/src/capture_store.rs)),
so total and unique counts are both O(1). `send_new_frames` pushes them on the
2 Hz frame cadence as `FrameCounts` (0x16); they are also surfaced on
`list_active_sessions` (`capture_frame_count` / `capture_unique_frame_count`).
`sessionStore` writes them onto the `Session` (`frameCount` / `uniqueFrameCount`),
and `useIOSessionManager` exposes them for rendering — replacing the old
frontend counting + `isWatching` latch that could stick at 0 after a restart. The
shared session-picker dot (`SessionButton`'s `ActivityDot`) derives a frames/sec rate
from `frameCount` to pulse a sonar ripple in step with bus activity — the dashboard's
old numeric "N frames" readout was dropped in favour of it.

### Subscription lifecycle

1. Frontend sends `Subscribe(sessionId)`.
2. Server's connection manager task allocates a free channel (1..254) and
   records `sessionId → channel` in a shared `CHANNEL_MAP` for non-blocking
   lookup from `dispatch.rs`.
3. Server sends `SubscribeAck{channel}`; frontend wires pending handlers.
   A handler registered before the ack is queued in `pendingHandlers` and
   *migrated* into the channel's map here — and re-staged into a fresh map on
   reconnect. So `onSessionMessage`'s unlisten looks the handler up on removal
   rather than closing over the map it was first put in; capturing that map
   makes the unlisten a silent no-op for any subscriber that registers before
   its session is joined, which is the normal case.
4. [`reset_frame_offset`](../src-tauri/src/ws/dispatch.rs#L74) is called so
   the client only receives frames that arrive after subscription.
5. On `Unsubscribe` (or disconnect), the channel refcount drops; if it hits
   zero the channel is released, the frame offset cleared, and any attached
   catalogue detached.

`sessionStore` owns the subscription for the built-in session message types and
tears them down wholesale via `wsTransport.unsubscribe`. A feature that owns its
own session-scoped subscription — `useModbusScanSync` is the one so far — relies
on the per-handler unlisten above, so its lifetime must be bounded by something
that actually changes: keying the effect on a session id the store clears when
the work ends, rather than on a value only written at the start.

### Reconnect resync

If the WebSocket drops, the transport reconnects with exponential backoff
([wsTransport.ts](../src/services/wsTransport.ts) `scheduleReconnect`). Channel
numbers are invalid after a reconnect, so the server reassigns them via fresh
`SubscribeAck`s. The transport **re-stages the existing per-session handlers**
(keyed by sessionId) before re-subscribing, so they are re-wired to the new
channels — without this the frontend would go deaf to a session the backend still
has alive and the UI would appear frozen. After re-subscribing, the transport
fires `onReconnect` listeners; [`useSessionRosterSync`](../src/hooks/useSessionRosterSync.ts)
uses this (and the global `SessionLifecycle` broadcast) to reconcile against the
backend roster (`list_active_sessions`). Reconciliation refreshes the
authoritative state (`ioState`, capabilities, subscriber count, capture, attached
catalogue path) of sessions the UI already owns — Rust is the source of truth — as
well as adopting
new backend sessions and dropping vanished adopted ones
([sessionRoster.ts](../src/stores/sessionRoster.ts)).

### What still uses Tauri events

Not everything is on WS. These remain Tauri-emitted:

- `session-lifecycle` broadcast of created/destroyed (also mirrored on WS
  global channel).
- `device-probe` — device discovery progress.
- `subscriber-evicted` — when the watchdog kicks a stale subscriber.
- `store:changed` — settings changes.
- `menu-*` — native menu actions.

### post_session cache

When a session ends, its `StreamEndedInfo`, errors, source info, and
orphaned-capture IDs are written to [io/post_session.rs](../src-tauri/src/io/post_session.rs)
with a 10-second TTL. This exists so a client that unsubscribes in the same
tick a stream ends can still fetch the outcome via command.

---

## 6. Watch vs Load (ingest)

Recorded sources (WireTAP backend, capture) offer two modes. Realtime sources only
support Watch.

```
                    User picks a source
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
      [Connect] Watch                 [Load] Ingest
                                      (recorded only)
            │                               │
            ▼                               ▼
   Frames flow via WS to              Frames counted into capture
   app onFrames callbacks.            (no UI rendering, fast ingest).
   Dialog closes immediately.         Dialog stays open showing progress.
                                      On StreamEnded, auto-switch to
                                      capture replay and close dialog.
```

After a Load the session transitions into capture replay; both paths end with
apps receiving frames through the same `onFrames` callback chain.

---

## 7. Multi-app session sharing

```
┌──────────────┐   watchSource(["gs_usb_1"])
│  Discovery   │──────────────────────┐
└──────────────┘                      │
                                      ▼
                             Session "f_abc123"
                             subscribers: [Discovery]
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌──────────────┐              ┌──────────────┐              ┌──────────────┐
│  Decoder     │              │    Graph     │              │  Transmit    │
│ joinSession  │              │ joinSession  │              │ joinSession  │
│ ("f_abc123") │              │ ("f_abc123") │              │ ("f_abc123") │
└──────────────┘              └──────────────┘              └──────────────┘
                                      │
                             Session "f_abc123"
                             subscribers: [Discovery, Decoder, Graph, Transmit]
                             Frames → all four apps via the same WS channel.
                             Playback position, speed, and state are shared.
                                      │
                         Last subscriber leaves → destroy_session
```

Each app registers a unique `subscriberId`. The Rust side tracks them in
`SessionSubscriber` records and destroys the session when the last one leaves.

---

## 8. Heartbeats, suspension, eviction

Defined in [io/mod.rs:627-633](../src-tauri/src/io/mod.rs#L627-L633):

```
HEARTBEAT_TIMEOUT_SECS          = 30   // subscriber is stale after 30s silence
HEARTBEAT_CHECK_INTERVAL_SECS   = 5    // watchdog runs every 5s
SUSPENSION_GRACE_PERIOD_SECS    = 300  // session survives 5 min with no subscribers
```

Watchdog loop:

```
every 5s:
  for each session:
    for each subscriber:
      if now - last_heartbeat > 30s: remove subscriber
    if session has no subscribers:
      if not yet suspended: pause device, set suspended_at = now
      else if now - suspended_at > 5 min: destroy_session
    if subscriber heartbeats resume: clear suspended_at, device.resume()
```

The 30-second stale threshold (up from 10s) is tuned for WKWebView timer
throttling during display sleep. Frontend heartbeats ride the WebSocket as
`Heartbeat` (0xFE) control frames; if the WS connection is down the frontend
falls back to polling via an `invoke` command.

The WebSocket *connection* itself times out separately, at
`2 × HEARTBEAT_TIMEOUT_SECS` ([ws/server.rs](../src-tauri/src/ws/server.rs)) —
deliberately longer than the subscriber timeout, so the socket outlives a
suspended session and a display-sleep wake resumes on the same connection
without re-subscribing.

### Wake lock

The same watchdog tick runs `update_wake_lock`. The machine is kept awake while
**either** a `Running` session has a live subscriber **or** any capture is
actively recording (`capture_store::has_streaming_captures()` — true while a
capture is in `streaming_ids`). The capture clause matters: closing the last
panel drops the subscribers but the source keeps recording, so the lock must
stay held independent of UI subscribers, otherwise the display sleeps mid-capture
(see WebView recovery below). The lock is released when neither holds, or when
both wake settings (`prevent_idle_sleep`, `keep_display_awake`) are off.

### WebView health probe & recovery (macOS)

While a session has been suspended longer than `PROBE_START_DELAY_SECS`, the
watchdog pings the dashboard webview each tick and expects a `webview_health_pong`
invoke back. After `PROBE_MAX_MISSES` (6) consecutive misses it concludes macOS
has jettisoned the WKWebView content process and triggers recovery: it navigates
the window to the **root URL captured at startup** (`DASHBOARD_ROOT_URL`). It must
*not* read the live `window.url()` here — wry's getter unwraps `URL()` (now
`None`) and panics on the Cocoa main thread, uncatchable from the watchdog task
and fatal to the app; `navigate()` to a known URL string is panic-free and is
what relaunches the content process. Keeping the wake lock held during an active
capture (above) prevents the display sleep that triggers the jettison in the
first place.

---

## 9. Transmit

Both `CanFrame` and `RawBytes` go through the unified `IOSource::transmit`
method using a `TransmitPayload` enum. The Transmit app chooses its view from
`InterfaceTraits.protocols` (frame protocols → `CanTransmitView`, byte
protocols → `SerialTransmitView`) and gates the send itself on
`tx_frames` / `tx_bytes`.

**Interval-driven loops share one cadence.** Repeating transmits (`io_start_repeat_transmit`,
the serial and group variants in [transmit.rs](../src-tauri/src/transmit.rs)) and
Modbus register polling (the poll task in
[io/broker/spawner.rs](../src-tauri/src/io/broker/spawner.rs), and the standalone
[io/modbus_tcp/reader.rs](../src-tauri/src/io/modbus_tcp/reader.rs)) are the same
skeleton — fire immediately, then once per interval, stopping on a cancel flag and
skipping ticks while paused — differing only in the per-tick body (a transmit logs a
`TransmitResult`; a poll emits a `FrameMessage` into the rx stream). That timing
triad lives in one place, `Cadence` ([io/periodic.rs](../src-tauri/src/io/periodic.rs)):
callers write `while cadence.next().await.is_some() { … }`. Modbus RTU keeps its own
sequential scheduler — half-duplex means requests must be strictly ordered, which a
per-task interval can't express.

---

## 10. Key files

### Frontend

| File | Role |
|------|------|
| [src/components/SessionControls.tsx](../src/components/SessionControls.tsx) | Session chip + click-to-open session menu (details, change source, playback, capture actions, disconnect, destroy) |
| [src/dialogs/IoSourcePickerDialog.tsx](../src/dialogs/IoSourcePickerDialog.tsx) | Unified source selection dialog |
| [src/dialogs/DeviceSettingsDialog.tsx](../src/dialogs/DeviceSettingsDialog.tsx) | Change a device's connection parameters, live or not (see [Reconfiguring a device](#reconfiguring-a-device)) |
| [src/dialogs/io-source-picker/DeviceEditor.tsx](../src/dialogs/io-source-picker/DeviceEditor.tsx) | Create a device from the picker (creation only) |
| [src/components/io/IOConnectionFields.tsx](../src/components/io/IOConnectionFields.tsx) | Per-kind connection fields, shared by every device form |
| [src/components/io/useConnectionProbe.ts](../src/components/io/useConnectionProbe.ts) | Debounced device probing while a form is edited |
| [src/hooks/useAllIOProfiles.ts](../src/hooks/useAllIOProfiles.ts) | Saved profiles + ad-hoc devices — the list that feeds session start |
| [src/stores/adHocProfileStore.ts](../src/stores/adHocProfileStore.ts) | Mirror of the Rust ephemeral registry |
| [src/stores/deviceEditorStore.ts](../src/stores/deviceEditorStore.ts) | Which device the device-settings dialog is open on |
| [src/dialogs/io-source-picker/ActionButtons.tsx](../src/dialogs/io-source-picker/ActionButtons.tsx) | Trait-driven action buttons |
| [src/dialogs/io-source-picker/LoadOptions.tsx](../src/dialogs/io-source-picker/LoadOptions.tsx) | Recorded source options (time bounds, speed) |
| [src/dialogs/io-source-picker/FramingOptions.tsx](../src/dialogs/io-source-picker/FramingOptions.tsx) | Serial framing options |
| [src/hooks/useIOSourcePickerHandlers.ts](../src/hooks/useIOSourcePickerHandlers.ts) | Dialog → session manager bridge |
| [src/hooks/useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts) | `watchSource` / `loadSource` / `joinSession` orchestration |
| [src/hooks/useIOSession.ts](../src/hooks/useIOSession.ts) | Per-subscriber session hook |
| [src/hooks/useCaptureSession.ts](../src/hooks/useCaptureSession.ts) | Capture switching helper |
| [src/stores/sessionStore.ts](../src/stores/sessionStore.ts) | Zustand store, `openSession`, WS routing to callbacks |
| [src/services/wsTransport.ts](../src/services/wsTransport.ts) | WebSocket client, subscribe/unsubscribe, message decode |
| [src/api/io.ts](../src/api/io.ts) | `IOCapabilities`, `InterfaceTraits`, `SessionDataStreams` types, Tauri command wrappers |

### Backend

| File | Role |
|------|------|
| [src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs) | `IOSource` trait, `IOSession`, lifecycle, `replace_session_source`, heartbeat watchdog |
| [src-tauri/src/io/traits.rs](../src-tauri/src/io/traits.rs) | `InterfaceTraits`, `SessionDataStreams`, validation/merge |
| [src-tauri/src/io/ephemeral.rs](../src-tauri/src/io/ephemeral.rs) | Ad-hoc device registry, overlaid onto `io_profiles` (see [Where a device lives](#where-a-device-lives--saved-and-ad-hoc-profiles)) |
| [src-tauri/src/io/profiles.rs](../src-tauri/src/io/profiles.rs) | `reconfigure_device` — write a device's settings and reconnect it |
| [src-tauri/src/io/device_kinds.rs](../src-tauri/src/io/device_kinds.rs) | Per-kind connection defaults and required fields (see [Connection defaults](#connection-defaults--one-table)) |
| [src-tauri/src/io/broker/](../src-tauri/src/io/broker/) | `IOBroker` — source aggregator / merge task |
| [src-tauri/src/io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs) | 2 Hz per-signal rate limiter |
| [src-tauri/src/io/periodic.rs](../src-tauri/src/io/periodic.rs) | `Cadence` — shared interval/cancel/pause primitive for repeat-transmit and Modbus polling |
| [src-tauri/src/io/post_session.rs](../src-tauri/src/io/post_session.rs) | 10 s TTL cache for post-session fetches |
| [src-tauri/src/ws/server.rs](../src-tauri/src/ws/server.rs) | WS server, channel allocation, auth |
| [src-tauri/src/ws/protocol.rs](../src-tauri/src/ws/protocol.rs) | Binary message format, `MsgType`, `encode_frame_batch` |
| [src-tauri/src/ws/dispatch.rs](../src-tauri/src/ws/dispatch.rs) | `send_new_frames`, `send_session_state`, `send_stream_ended`, etc. |
| [src-tauri/src/capture_store.rs](../src-tauri/src/capture_store.rs) | Session-scoped capture registry (see [capture-flow.md](capture-flow.md)) |
| [src-tauri/src/credentials.rs](../src-tauri/src/credentials.rs) | Keyring namespaces, `resolve_secret`, `split_secrets`, legacy-namespace drain (see [IO-profile secrets](#io-profile-secrets)) |
