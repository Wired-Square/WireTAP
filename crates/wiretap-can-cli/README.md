# wiretap-can-cli

A can-utils work-alike for every CAN adapter WireTAP drives, on macOS, Windows
and Linux. It opens devices through `wiretap-io`, the same code the app runs,
and needs no Tauri.

## Building

From the repository root:

```bash
cargo build --release -p wiretap-can-cli
```

The binary is `target/release/wiretap-can-cli`.

## Interfaces

| Interface | Form | Notes |
|-----------|------|-------|
| gs_usb / candleLight | `gsusb:<serial>[/<channel>]`, `gsusb:<bus:addr>[/<channel>]` | macOS and Windows. On Linux the kernel driver makes it a SocketCAN interface; `list` names it |
| SLCAN | `slcan:<port>` | `slcan:/dev/cu.usbmodem1101`, `slcan:COM3`; 115200 8N1 |
| SocketCAN | `socketcan:<if>` | Linux only; the bit rate is set with `ip link` |
| GVRET | `gvret:<host:port>` | over TCP; the bus rate is set on the device |

## Bus options

Every command takes these, and refuses one the transport cannot take:

| Flag | Default | gs_usb | SLCAN | SocketCAN | GVRET |
|------|---------|--------|-------|-----------|-------|
| `--bitrate` | 500000 | yes | yes | checked against the interface | no |
| `--dbitrate` | off | yes, enables CAN FD | yes, Elmue firmware | checked against the interface | no |
| `--listen-only` | off | yes | yes | yes | yes |
| `--sample-point` | 87.5 | yes | no | no | no |
| `--can-clock` | device's | yes | no | no | no |

## Commands

### `list`

gs_usb adapters, serial ports, and SocketCAN interfaces on Linux, each as an
interface argument.

```bash
wiretap-can-cli list
```

### `probe`

What the device says of itself, without starting its channel. On SocketCAN,
the interface's configured rates.

```bash
wiretap-can-cli probe gsusb:205933B831335010
```

### `dump`

Frames as `candump -L` prints them: `(sec.usec) <ifname> <id>#<data>`, `##<flags>`
for CAN FD (BRS 1, ESI 2) and `R` for a remote frame. `--own` adds this host's
own sends and a trailing ` T` or ` R` on every line, as `candump -x` does. The
interface name is the argument with each run of other characters made `-`, so
`gsusb:205933B831335010/1` logs as `gsusb-205933B831335010-1`. Times are the
host's wall clock.

```bash
wiretap-can-cli dump gsusb:205933B831335010 --dbitrate 2000000 --listen-only
wiretap-can-cli dump slcan:COM3 --own --count 1000 > walk.log
```

This is the format `scripts/hw-walk/walk-diff` scores. It is not a reference
for the hardware walk, since it runs the code under test; `candump` on Linux is.

### `send`

One frame in `cansend` syntax: `123#DEADBEEF`, `12345678#01.02` (extended),
`123##1<data>` (CAN FD with BRS; an FD payload is zero-padded to its length
code), `123#R` or `123#R4` (remote). A frame the device cannot carry is
refused with the reason.

```bash
wiretap-can-cli send gsusb:205933B831335010 123#DEADBEEF
wiretap-can-cli send gsusb:205933B831335010 123##1112233 --dbitrate 2000000
```

### `gen`

`cangen`'s deterministic modes: `-g <ms>`, `-n <count>`, `-I i|<hex>`,
`-L i|<len>`, `-D i|<hex>`, `-e`, `-R`, `-f` and `-b`. The frames match
can-utils: `-D i` is a little-endian counter in the first eight bytes, and never
goes out in an empty frame. Where `cangen` would pick at random, the id and
length increment and the data is zeros.

```bash
wiretap-can-cli gen slcan:COM3 -I i -L i -D i -g 1 -n 10000
wiretap-can-cli gen gsusb:205933B831335010 -b -I i -L i -D i -g 1 --dbitrate 2000000
```

### `pattern`

One end of a Test Pattern exchange (`wiretap_protocol::testpattern`). A
responder answers until Ctrl-C or `--duration`; an initiator runs `--mode`
`echo`, `sweep`, `throughput`, `latency` or `reliability` for `--duration`
seconds (10), prints the result and exits 1 on a failure. `--dbitrate` makes
the run CAN FD, and `--extended` puts the framed messages on 29-bit ids.

```bash
wiretap-can-cli pattern socketcan:can1 responder
wiretap-can-cli pattern gsusb:205933B831335010 initiator --mode sweep --dbitrate 2000000
```

### `gsusb diag`

USB descriptors, the gs_usb device config, `BT_CONST` with its feature flags,
and the bulk endpoints. macOS and Windows.

```bash
wiretap-can-cli gsusb diag gsusb:205933B831335010
```
