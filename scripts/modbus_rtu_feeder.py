#!/usr/bin/env python3
"""Generate a synthetic Modbus RTU line, as hex, for WireTAP's `ingest_bytes`.

The stream is shaped like a Sungrow logger's RS-485 line: register polling on
two slaves, a coil read whose block is only partly used, a single-coil write, an
occasional exception — and three function codes the Modbus spec never defined,
one of them broadcast from address 0.

Undeclared, the vendor messages do not merely fail to frame: the bytes they
leave behind swallow the legitimate messages after them. Over the four cycles
wiretap-catalog's `framing_detect` tests pin (`--start 8 --cycles 4`, 41
messages) that is 14 framed out of 41. Declaring 0x20, 0x60 and 0x65 and
allowing broadcast recovers all 41 — which is the thing worth seeing in the app.

`--rules` lays 0x60 and 0x65 out as the Sungrow catalogue's length rules read
them, so the line frames with that catalogue attached (its `RULES_LINE` pin).

    python3 scripts/modbus_rtu_feeder.py            # 24 cycles of hex
    python3 scripts/modbus_rtu_feeder.py --start 8 --cycles 4   # the pinned 14/41 stream
    python3 scripts/modbus_rtu_feeder.py --rules --start 8 --cycles 4   # the rule-path pin
    python3 scripts/modbus_rtu_feeder.py --stock    # no vendor traffic
    python3 scripts/modbus_rtu_feeder.py --annotate # one message per line, labelled

Feed the hex to the `ingest_bytes` MCP tool, then open the resulting capture in
Discovery and set framing to Modbus RTU.

(There is deliberately no virtual serial port here: `serialport` cannot open a
PTY on macOS — it fails with ENOTTY on the baud-rate ioctl — so a PTY feeder
would be a trap on the platform this is developed on.)
"""

import argparse
import sys


def crc16(data: bytes) -> bytes:
    """CRC-16/Modbus, little-endian on the wire."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, crc >> 8])


def msg(body: bytes) -> bytes:
    return body + crc16(body)


def stock_cycle(n: int) -> list[tuple[str, bytes]]:
    """Traffic any Modbus line carries — framed with no configuration at all."""
    level = 0x012C + (n % 40)
    return [
        # FC04 read input registers: request, then the response answering it.
        ("FC04 req", msg(bytes([0x01, 0x04, 0x4D, 0xE2, 0x00, 0x02]))),
        ("FC04 resp", msg(bytes([0x01, 0x04, 0x04, level >> 8, level & 0xFF, 0x00, 0x00]))),
        # FC03 holding registers on a second slave.
        ("FC03 req", msg(bytes([0x02, 0x03, 0x00, 0x10, 0x00, 0x01]))),
        ("FC03 resp", msg(bytes([0x02, 0x03, 0x02, 0x00, (n % 7) + 1]))),
        # FC01 read coils: 10 coils, so the block is 2 bytes with the second only
        # partly used — the case that used to come back as mangled registers.
        ("FC01 req", msg(bytes([0x01, 0x01, 0x00, 0x00, 0x00, 0x0A]))),
        ("FC01 resp", msg(bytes([0x01, 0x01, 0x02, 0xD5 if n % 2 else 0x2A, 0x02]))),
        # FC05 write single coil: a flag word, not a packed block.
        ("FC05", msg(bytes([0x01, 0x05, 0x00, 0x1A, 0xFF if n % 3 else 0x00, 0x00]))),
    ]


def vendor_cycle(n: int, rules: bool) -> list[tuple[str, bytes]]:
    """What makes the line not stock Modbus: three undefined function codes and a
    master that broadcasts to address 0. None of this frames until declared.
    With `rules`, 0x60's count byte is the 7 bytes it carries and 0x65 carries a
    one-byte block counted at b[4]."""
    telemetry = [0x01, 0x65, 0x00, 0x02] + ([0x01] if rules else []) + [n % 256]
    return [
        ("0x20 battery", msg(bytes([0x01, 0x20, 0x01, 0xC8, 0x03, 0x11, 0x1A, 0x00, n % 8]))),
        ("0x60 broadcast", msg(bytes([0x00, 0x60, 0x00, 0x00, 0x00, 0x05, 0x07 if rules else 0x0A,
                                      0x00, 0x04, 0x01, 0xBB, 0x03, 0xE8, 0x08]))),
        ("0x65 telemetry", msg(bytes(telemetry))),
    ]


def exception_cycle(n: int) -> list[tuple[str, bytes]]:
    """Once in a while the slave refuses — five bytes, shorter than its own
    function code's length rule."""
    return [("FC04 exception", msg(bytes([0x01, 0x84, 0x02])))] if n % 11 == 10 else []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cycles", type=int, default=24, help="poll cycles to emit (default 24)")
    ap.add_argument("--start", type=int, default=0,
                    help="first cycle number (default 0). Cycle content varies with the "
                         "number, so this is what makes a given stream reproducible.")
    ap.add_argument("--stock", action="store_true",
                    help="emit only spec-defined traffic (no vendor codes, no broadcast)")
    ap.add_argument("--rules", action="store_true",
                    help="lay the vendor messages out as the Sungrow catalogue's length rules read them")
    ap.add_argument("--annotate", action="store_true",
                    help="one labelled message per line instead of one hex blob")
    args = ap.parse_args()

    messages: list[tuple[str, bytes]] = []
    for n in range(args.start, args.start + max(args.cycles, 1)):
        messages += stock_cycle(n)
        if not args.stock:
            messages += vendor_cycle(n, args.rules)
        messages += exception_cycle(n)

    if args.annotate:
        for label, data in messages:
            print(f"{label:16} {data.hex(' ')}")
        total = sum(len(d) for _, d in messages)
        print(f"\n{len(messages)} messages, {total} bytes", file=sys.stderr)
    else:
        print("".join(d.hex() for _, d in messages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
