# Hardware walk recipes

The `ip link`, `cangen` and `candump` commands per test in the hardware walk
(the vault's `Handovers/hardware-walk.md`). The reference is always D1 ch0 on
Linux (`can0`) running `can-utils` only; WireTAP is on another node.

## Bring-up (Linux)

Classic, 500 k (`can0` reference, `can1` WireTAP SocketCAN and responder):

```sh
for i in can0 can1; do
  sudo ip link set $i down
  sudo ip link set $i type can bitrate 500000 restart-ms 100
  sudo ip link set $i txqueuelen 1000
  sudo ip link set $i up
done
```

FD, 500 k / 2 M (`can2`, F1 on the kernel gs_usb driver; D1, D2 and S unplugged
from the bus):

```sh
sudo ip link set can2 down
sudo ip link set can2 type can bitrate 500000 dbitrate 2000000 fd on restart-ms 100
sudo ip link set can2 txqueuelen 1000
sudo ip link set can2 up
ip -details link show can2    # the can line must show <FD>
```

## Recording and scoring

Every test records the reference the same way, started before the traffic and
stopped two seconds after it:

```sh
candump -L -x -t a can0 > $TEST.log &  DUMP=$!
# ... the test's traffic ...
sleep 2; kill $DUMP
```

The WireTAP side is the session's capture, paged out with MCP
`get_capture_frames` (one response per line in `$TEST.json`). Score it with:

```sh
scripts/hw-walk/walk-diff $TEST.log $TEST.json            # add --json for the numbers
```

`--direction opposite` (the default) expects the reference's `T` as WireTAP's
`rx` and its `R` as `tx`. Use `same` when `candump` and WireTAP read one
interface, and `ignore` when a third node talks as well. `--bus N` scores one
bus of a multi-channel device.

## Traffic per test

`cangen -I i -L i -D i` gives incrementing ids, lengths and data, so `walk-diff`
reads the data as a sequence number.

| # | Reference traffic (on `can0` unless noted) | Score |
|---|---|---|
| R1 std | `cangen can0 -I i -L i -D i -g 1 -n 10000` | `walk-diff`: all zero |
| R1 ext | `cangen can0 -e -I i -L i -D i -g 1 -n 10000` | as R1 std |
| R1 RTR | `cangen can0 -R -I i -L i -g 1 -n 10000` | as R1 std; each RTR arrives as an empty frame |
| R1 FD | `cangen can2 -f -b -I i -L i -D i -g 1 -n 10000`, then without `-b` | `walk-diff`, `length` 0: codes 9–15 arrive as 12–64 bytes |
| R2 | `timeout 60 cangen can0 -g 0 -p 10 -I i -L i -D i` | `walk-diff` drops 0; `get_capture_count` equals `grep -c . r2.log` |
| R3 | `cangen can0 -I i -L i -D i -g 5 -n 2000` | `walk-diff` gap error: median < 1 ms on gs_usb and SocketCAN; record SLCAN's |
| T1 | none: WireTAP sends each class with `transmit_frame`, then `replay_capture` of the R1 std capture at `speed` 1 and 10, each into a fresh session | `walk-diff` all zero; replay gap error median < 1 ms |
| T2 | none: WireTAP sends the refused frames | `t2.log` is empty |
| T3 | none: WireTAP sends with `transmit_frame` | `walk-diff` direction 0 (WireTAP exports them as `tx`) |
| E1 | none: `test_pattern_start` responder on `can1`, initiator on the node under test, modes echo, throughput, latency | `test_pattern_state` drops, duplicates, out_of_order 0; `walk-diff --direction ignore` against the initiator's capture all zero, so `candump` agrees on the count |
| E2 | none: responder on `can2` (`use_fd`), initiator mode sweep with `use_fd`; record `candump ... can2` | every sweep row passed; `walk-diff` `length` 0 |
| E3 | none: responder as E1, initiator mode auto | the responder's `test_pattern_state` is `listening` between phases |
| L1 | `cangen can0 -I i -L i -D i -g 5 -n 12000`, unplugged and replugged mid-run | `walk-diff` fails on drops only (the frames sent while unplugged): duplicates, reordered, unexpected and mismatches 0 |
| L2 | none | start fails with the reason; `list_sessions` has no session for it |
| P1 | none: `ip -details link show` for the gs_usb listing | works, or fails with a clear message |
| P2 | R1 std with `-n 1000`, and T1's `transmit_frame` with `bus: 1` | `walk-diff --bus 1` all zero |

A node whose transmits are not echoed into its capture has nothing for T1 to
score: score its replay against the source capture with `--direction ignore`,
which checks content but not spacing.

## Dry run on vcan

`walk-diff` against itself, to check the parser and a real `cangen` log before
any hardware:

```sh
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 up
candump -L -x -t a vcan0 > dry.log &  DUMP=$!
cangen vcan0 -I i -L i -D i -g 1 -n 1000
sleep 1; kill $DUMP
scripts/hw-walk/walk-diff dry.log dry.log --direction same   # mode sequence, PASS
```
