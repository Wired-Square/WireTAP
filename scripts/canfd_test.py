#!/usr/bin/env python3
"""
Bring up a virtual CAN interface on Linux and send eye-catching test frames.
Supports both classic CAN (8-byte) and CAN FD (up to 64-byte) frames.

Usage:
    sudo python3 canfd_test.py --setup                      # setup classic CAN
    sudo python3 canfd_test.py --setup --canfd               # setup with CAN FD MTU
    python3 canfd_test.py --send                             # send classic CAN frames
    python3 canfd_test.py --send --canfd                     # send CAN FD frames
    python3 canfd_test.py --monitor                          # watch frames (like candump)
    sudo python3 canfd_test.py -i vcan1 --setup --send --monitor --canfd
"""

import argparse
import errno
import os
import select
import socket
import struct
import subprocess
import sys
import threading
import time

DEFAULT_INTERFACE = "vcan0"
DEFAULT_BITRATE = 500000
DEFAULT_DBITRATE = 2000000
DEFAULT_DELAY = 100        # ms between frames
DEFAULT_CYCLE_PAUSE = 1000 # ms between cycles

# CAN socket constants
CAN_RAW = 1
CAN_RAW_FD_FRAMES = 5
CANFD_BRS = 0x01   # Bit Rate Switch
CANFD_MTU = 72     # sizeof(struct canfd_frame)
CAN_MTU = 16       # sizeof(struct can_frame)


def format_bitrate(bps: int) -> str:
    """Format a bitrate for display (e.g. 500000 -> 500 kbit/s)."""
    if bps >= 1_000_000 and bps % 1_000_000 == 0:
        return f"{bps // 1_000_000} Mbit/s"
    if bps >= 1_000 and bps % 1_000 == 0:
        return f"{bps // 1_000} kbit/s"
    return f"{bps} bit/s"


def print_info(args):
    """Print a configuration summary banner."""
    mode = "CAN FD" if args.canfd else "Classic CAN"
    max_dlc = 64 if args.canfd else 8
    actions = []
    if args.setup:
        actions.append("setup")
    if args.send:
        actions.append("send")
    if args.monitor:
        actions.append("monitor")

    is_vcan = args.interface.startswith("vcan")

    print("=" * 60)
    print("  CAN Test Tool")
    print("=" * 60)
    print(f"  Interface     : {args.interface} ({'virtual' if is_vcan else 'physical'})")
    print(f"  Mode          : {mode}")
    print(f"  Max payload   : {max_dlc} bytes")
    if not is_vcan:
        print(f"  Bitrate       : {format_bitrate(args.bitrate)}")
        if args.canfd:
            print(f"  Data bitrate  : {format_bitrate(args.dbitrate)}")
            print("  BRS           : enabled")
    else:
        print("  Bitrate       : N/A (virtual bus)")
    if args.send:
        print(f"  Frame delay   : {args.delay} ms")
        print(f"  Cycle pause   : {args.cycle_pause} ms")
        print("  Patterns      : 8 + counter")
        cycles_str = str(args.cycles) if args.cycles > 0 else "infinite"
        print(f"  Cycles        : {cycles_str}")
    print(f"  Actions       : {', '.join(actions)}")
    print("=" * 60)
    print()


def query_interface_info(interface: str):
    """Query and display the live configuration of a CAN interface."""
    print("=" * 60)
    print(f"  Interface Info: {interface}")
    print("=" * 60)

    # Check if interface exists
    result = subprocess.run(
        ["ip", "-details", "link", "show", interface],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  Interface {interface} not found.")
        print("=" * 60)
        return

    link_lines = result.stdout.strip().splitlines()
    for line in link_lines:
        line = line.strip()
        # First line: index, name, flags, mtu, state
        if line.startswith(f"{interface}:") or "mtu" in line:
            # Extract state
            if "UP" in line and "LOWER_UP" in line:
                state = "UP"
            elif "DOWN" in line:
                state = "DOWN"
            else:
                state = "UNKNOWN"
            # Extract MTU
            mtu = None
            parts = line.split()
            for j, p in enumerate(parts):
                if p == "mtu" and j + 1 < len(parts):
                    mtu = parts[j + 1]
                    break
            if mtu:
                is_fd_capable = mtu == "72"
                print(f"  State         : {state}")
                print(f"  MTU           : {mtu} ({'CAN FD' if is_fd_capable else 'Classic CAN'})")

    # Get CAN-specific details
    result = subprocess.run(
        ["ip", "-details", "-statistics", "link", "show", interface],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print("=" * 60)
        return

    output = result.stdout

    # Parse CAN-specific info from ip -details output
    is_vcan = interface.startswith("vcan")
    if is_vcan:
        print("  Type          : virtual (vcan)")
        print("  Bitrate       : N/A (virtual bus)")
    else:
        print("  Type          : physical")

    for line in output.splitlines():
        line = line.strip()

        # Bitrate line: "bitrate 500000 sample-point 0.875"
        if line.startswith("bitrate") and "sample-point" in line:
            parts = line.split()
            if len(parts) >= 2:
                try:
                    bps = int(parts[1])
                    print(f"  Bitrate       : {format_bitrate(bps)}")
                except ValueError:
                    pass
            if "sample-point" in line:
                idx = parts.index("sample-point")
                if idx + 1 < len(parts):
                    print(f"  Sample point  : {parts[idx + 1]}")

        # Data bitrate (CAN FD): "dbitrate 2000000 dsample-point 0.750"
        if line.startswith("dbitrate"):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    dbps = int(parts[1])
                    print(f"  Data bitrate  : {format_bitrate(dbps)}")
                except ValueError:
                    pass
            if "dsample-point" in line:
                idx = parts.index("dsample-point")
                if idx + 1 < len(parts):
                    print(f"  Data samp. pt : {parts[idx + 1]}")

        # Clock frequency
        if "clock" in line and "Hz" in line:
            # e.g. "clock 80000000"
            parts = line.split()
            for j, p in enumerate(parts):
                if p == "clock" and j + 1 < len(parts):
                    try:
                        hz = int(parts[j + 1])
                        if hz >= 1_000_000:
                            print(f"  Clock         : {hz / 1_000_000:.0f} MHz")
                        else:
                            print(f"  Clock         : {hz} Hz")
                    except ValueError:
                        pass

        # Controller state
        if "state" in line and ("ERROR" in line or "ACTIVE" in line or "STOPPED" in line
                                or "BUS-OFF" in line or "SLEEPING" in line):
            parts = line.split()
            for j, p in enumerate(parts):
                if p == "state" and j + 1 < len(parts):
                    print(f"  Bus state     : {parts[j + 1]}")

        # Restart-ms
        if "restart-ms" in line:
            parts = line.split()
            for j, p in enumerate(parts):
                if p == "restart-ms" and j + 1 < len(parts):
                    print(f"  Restart-ms    : {parts[j + 1]}")

    # RX/TX statistics
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("RX:"):
            # Next line has the values — find it
            lines_list = output.splitlines()
            idx = None
            for j, ln in enumerate(lines_list):
                if ln.strip().startswith("RX:"):
                    idx = j
                    break
            if idx is not None and idx + 1 < len(lines_list):
                header = lines_list[idx].strip().split()
                values = lines_list[idx + 1].strip().split()
                if len(header) >= 2 and len(values) >= 2:
                    stats = dict(zip(header[1:], values))
                    parts_str = "  ".join(f"{k}: {v}" for k, v in stats.items())
                    print(f"  RX stats      : {parts_str}")
            break

    for line in output.splitlines():
        line = line.strip()
        if line.startswith("TX:"):
            lines_list = output.splitlines()
            idx = None
            for j, ln in enumerate(lines_list):
                if ln.strip().startswith("TX:"):
                    idx = j
                    break
            if idx is not None and idx + 1 < len(lines_list):
                header = lines_list[idx].strip().split()
                values = lines_list[idx + 1].strip().split()
                if len(header) >= 2 and len(values) >= 2:
                    stats = dict(zip(header[1:], values))
                    parts_str = "  ".join(f"{k}: {v}" for k, v in stats.items())
                    print(f"  TX stats      : {parts_str}")
            break

    print("=" * 60)
    print()


def setup_interface(interface: str, canfd: bool, bitrate: int, dbitrate: int):
    """Load vcan module or configure a physical CAN interface."""
    is_vcan = interface.startswith("vcan")

    if is_vcan:
        mtu = "72" if canfd else "16"
        commands = [
            ["modprobe", "vcan"],
            ["ip", "link", "add", "dev", interface, "type", "vcan"],
            ["ip", "link", "set", interface, "mtu", mtu],
            ["ip", "link", "set", interface, "up"],
        ]
    else:
        # Physical CAN interface (e.g. can0, slcan0)
        commands = [["ip", "link", "set", interface, "down"]]
        if canfd:
            commands.append([
                "ip", "link", "set", interface, "type", "can",
                "bitrate", str(bitrate),
                "dbitrate", str(dbitrate),
                "fd", "on",
            ])
        else:
            commands.append([
                "ip", "link", "set", interface, "type", "can",
                "bitrate", str(bitrate),
            ])
        commands.append(["ip", "link", "set", interface, "up"])

    for cmd in commands:
        print(f"  $ {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            if "exists" in result.stderr.lower():
                print("    (already exists, skipping)")
                continue
            print(f"    ERROR: {result.stderr.strip()}", file=sys.stderr)
            sys.exit(1)

    mode = "CAN FD" if canfd else "classic CAN"
    print(f"\n{interface} is up for {mode}.\n")


def build_can_frame(can_id: int, data: bytes) -> bytes:
    """Build a classic can_frame struct (16 bytes)."""
    padded = data[:8].ljust(8, b"\x00")
    return struct.pack("=IBB2s8s", can_id, min(len(data), 8), 0, b"\x00\x00", padded)


def build_canfd_frame(can_id: int, data: bytes, flags: int = CANFD_BRS) -> bytes:
    """Build a canfd_frame struct (72 bytes)."""
    padded = data.ljust(64, b"\x00")
    return struct.pack("=IBB2s64s", can_id, len(data), flags, b"\x00\x00", padded)


def parse_frame(raw: bytes) -> tuple:
    """Parse a raw canfd_frame or can_frame from the socket."""
    is_fd = len(raw) == CANFD_MTU
    can_id, dlen, flags = struct.unpack_from("=IBB", raw, 0)

    eff = bool(can_id & 0x80000000)
    rtr = bool(can_id & 0x40000000)
    err = bool(can_id & 0x20000000)
    base_id = can_id & 0x1FFFFFFF if eff else can_id & 0x7FF

    data = raw[8 : 8 + dlen]
    return base_id, dlen, flags, data, is_fd, eff, rtr, err


def monitor(interface: str):
    """Monitor CAN frames on the interface (like candump -x)."""
    sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW, CAN_RAW)
    sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
    sock.bind((interface,))
    sock.setblocking(False)

    print(f"Monitoring {interface} — Ctrl+C to stop\n")

    frame_count = 0
    t_start = time.monotonic()

    try:
        while True:
            ready, _, _ = select.select([sock], [], [], 1.0)
            if not ready:
                continue

            raw = sock.recv(CANFD_MTU)
            frame_count += 1
            ts = time.strftime("%H:%M:%S", time.localtime())

            base_id, dlen, flags, data, is_fd, eff, rtr, err = parse_frame(raw)

            id_str = f"{base_id:08X}" if eff else f"{base_id:03X}"
            tag = "CANFD" if is_fd else "  CAN"

            flag_parts = []
            if is_fd and (flags & CANFD_BRS):
                flag_parts.append("BRS")
            if rtr:
                flag_parts.append("RTR")
            if err:
                flag_parts.append("ERR")
            flag_str = f" [{','.join(flag_parts)}]" if flag_parts else ""

            hex_data = " ".join(f"{b:02X}" for b in data)
            print(f"  {ts}  {interface}  {tag}  {id_str}  [{dlen:2d}]{flag_str}  {hex_data}")

    except KeyboardInterrupt:
        elapsed = time.monotonic() - t_start
        fps = frame_count / elapsed if elapsed > 0 else 0
        print(f"\nStopped monitoring. {frame_count} frames in {elapsed:.1f}s ({fps:.1f} frames/s)")
    finally:
        sock.close()


def _read_sysfs(interface: str, path: str) -> str | None:
    """Read a sysfs value for a CAN interface, returning None if unavailable."""
    try:
        with open(f"/sys/class/net/{interface}/{path}") as f:
            return f.read().strip()
    except (FileNotFoundError, PermissionError):
        return None


def _read_sysfs_int(interface: str, path: str) -> int:
    """Read a sysfs integer value, returning 0 if unavailable."""
    val = _read_sysfs(interface, path)
    try:
        return int(val) if val else 0
    except ValueError:
        return 0


def _get_bus_health(interface: str) -> dict:
    """Read bus state and error counters from sysfs."""
    return {
        "state": _read_sysfs(interface, "can/state") or "unknown",
        "tx_errors": _read_sysfs_int(interface, "statistics/tx_errors"),
        "rx_errors": _read_sysfs_int(interface, "statistics/rx_errors"),
        "tx_dropped": _read_sysfs_int(interface, "statistics/tx_dropped"),
        "restarts": _read_sysfs_int(interface, "can/restarts") if _read_sysfs(interface, "can/restarts") else 0,
    }


def _start_bus_health_thread(interface: str):
    """Monitor bus health in the background and print warnings.

    Checks sysfs every second for:
    - Bus state changes (ERROR-ACTIVE → ERROR-WARNING → ERROR-PASSIVE → BUS-OFF)
    - TX error counter incrementing (typically means no ACK from other nodes)
    - Bus restarts
    """
    stop_event = threading.Event()
    baseline = _get_bus_health(interface)
    last_state = baseline["state"]
    last_tx_errors = baseline["tx_errors"]
    last_restarts = baseline["restarts"]
    ack_warned = False

    def _check():
        nonlocal last_state, last_tx_errors, last_restarts, ack_warned

        while not stop_event.is_set():
            stop_event.wait(1.0)
            if stop_event.is_set():
                break

            health = _get_bus_health(interface)

            # Bus state change
            if health["state"] != last_state:
                state_upper = health["state"].upper()
                if health["state"] in ("bus-off", "error-passive", "error-warning"):
                    print(f"\n  *** BUS STATE: {state_upper} ***")
                    if health["state"] == "bus-off":
                        print("  *** Bus is OFF — no communication possible ***")
                elif health["state"] == "error-active":
                    print(f"\n  *** BUS STATE: {state_upper} (recovered) ***")
                last_state = health["state"]

            # TX errors incrementing = likely no ACK
            new_tx_errors = health["tx_errors"] - last_tx_errors
            if new_tx_errors > 0:
                if not ack_warned:
                    print(f"\n  *** NO ACK — TX errors incrementing "
                          f"(+{new_tx_errors}, total: {health['tx_errors']}) ***")
                    print("  *** Check: other node powered? correct bitrate? "
                          "bus terminated? ***")
                    ack_warned = True
                elif new_tx_errors > 10:
                    # Periodic reminder if errors keep climbing
                    print(f"\n  *** TX errors still climbing "
                          f"(+{new_tx_errors}, total: {health['tx_errors']}) ***")
                last_tx_errors = health["tx_errors"]
            else:
                # Errors stopped — bus might be healthy now
                if ack_warned:
                    print("\n  *** TX errors stopped — bus appears healthy ***")
                    ack_warned = False

            # Bus restarts
            if health["restarts"] > last_restarts:
                print(f"\n  *** BUS RESTART detected "
                      f"(total: {health['restarts']}) ***")
                last_restarts = health["restarts"]

    t = threading.Thread(target=_check, daemon=True)
    t.start()
    return stop_event, baseline


def _start_drain_thread(interface: str):
    """Spawn a background thread that silently consumes loopback frames.

    On vcan (and loopback-enabled physical interfaces), every sent frame is
    echoed back to all sockets on that interface. Without a reader the kernel
    buffer fills up and send() fails with ENOBUFS. This drain thread acts as
    a silent listener so --send works without --monitor or an external candump.
    """
    drain_sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW, CAN_RAW)
    drain_sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
    drain_sock.bind((interface,))
    drain_sock.setblocking(False)

    stop_event = threading.Event()

    def _drain():
        while not stop_event.is_set():
            ready, _, _ = select.select([drain_sock], [], [], 0.5)
            if ready:
                try:
                    drain_sock.recv(CANFD_MTU)
                except OSError:
                    pass

    t = threading.Thread(target=_drain, daemon=True)
    t.start()
    return drain_sock, stop_event


def send_test_frames(interface: str, canfd: bool, delay_ms: int, cycle_pause_ms: int,
                     max_cycles: int, has_listener: bool = False):
    """Send a repeating cycle of distinctive test frames."""
    sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW, CAN_RAW)
    if canfd:
        sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
    sock.bind((interface,))

    # On vcan, loopback frames need a reader or the kernel buffer fills up.
    # On real hardware, ENOBUFS means the TX mailbox is full (no ACK, bus error, etc.)
    drain_sock = None
    drain_stop = None
    health_stop = None
    health_baseline: dict = {}
    is_vcan = interface.startswith("vcan")
    if is_vcan and not has_listener:
        drain_sock, drain_stop = _start_drain_thread(interface)
    if not is_vcan:
        # Show initial bus state and start monitoring for ACK errors
        health = _get_bus_health(interface)
        state_upper = health["state"].upper()
        print(f"  Bus state: {state_upper}  "
              f"(TX errors: {health['tx_errors']}, RX errors: {health['rx_errors']})")
        if health["state"] != "error-active":
            print("  *** WARNING: Bus is not ERROR-ACTIVE — "
                  "check wiring and remote node ***")
        health_stop, health_baseline = _start_bus_health_thread(interface)

    if canfd:
        patterns = [
            (0x100, bytes([0xC0, 0xFF, 0xEE, 0x42] * 16), "C0FFEE42 x16 (64 bytes)"),
            (0x200, bytes(range(64)),                       "Sequential 00..3F (64 bytes)"),
            (0x300, b"\xFF" * 64,                           "All FF (64 bytes)"),
            (0x400, b"\xAA\x55" * 32,                       "Alternating AA/55 (64 bytes)"),
            (0x0F0, bytes([0xCA, 0xFE, 0xF0, 0x0D] * 16),  "CAFEF00D x16 (64 bytes)"),
            (0x500, b"\x01\x02\x04\x08\x10\x20\x40\x80" * 8, "Walking bit (64 bytes)"),
            (0x600, b"\x00" * 8,                            "Classic-size zeros (8 bytes)"),
            (0x7FF, b"\x42" * 48,                           "All 0x42 (48 bytes)"),
        ]
    else:
        patterns = [
            (0x100, bytes([0xC0, 0xFF, 0xEE, 0x42, 0xC0, 0xFF, 0xEE, 0x42]), "C0FFEE42 x2"),
            (0x200, bytes(range(8)),          "Sequential 00..07"),
            (0x300, b"\xFF" * 8,              "All FF"),
            (0x400, b"\xAA\x55\xAA\x55\xAA\x55\xAA\x55", "Alternating AA/55"),
            (0x0F0, bytes([0xCA, 0xFE, 0xF0, 0x0D, 0xCA, 0xFE, 0xF0, 0x0D]), "CAFEF00D x2"),
            (0x500, b"\x01\x02\x04\x08\x10\x20\x40\x80", "Walking bit"),
            (0x600, b"\x00" * 8,              "All zeros"),
            (0x7FF, b"\x42" * 8,              "All 0x42"),
        ]

    mode = "CAN FD" if canfd else "classic CAN"
    print(f"Sending {mode} test frames on {interface}")
    if is_vcan and not has_listener:
        print("  (drain thread active — no external listener needed)")
    print("-" * 60)

    delay_s = delay_ms / 1000.0
    cycle_pause_s = cycle_pause_ms / 1000.0
    total_frames = 0
    dropped_frames = 0
    t_start = time.monotonic()

    def try_send(frame: bytes) -> bool:
        """Send a frame, retrying on ENOBUFS. Returns True if sent."""
        nonlocal dropped_frames
        max_retries = 5
        for attempt in range(max_retries):
            try:
                sock.send(frame)
                return True
            except OSError as e:
                if e.errno == errno.ENOBUFS:
                    if attempt < max_retries - 1:
                        time.sleep(0.05 * (attempt + 1))
                    else:
                        dropped_frames += 1
                        print("    [ENOBUFS -- frame dropped, TX buffer full]")
                        return False
                else:
                    raise
        return False

    cycle = 0
    try:
        while True:
            cycle += 1
            if max_cycles > 0 and cycle > max_cycles:
                break
            print(f"\n--- Cycle {cycle} ---")
            for can_id, data, desc in patterns:
                if canfd:
                    frame = build_canfd_frame(can_id, data)
                else:
                    frame = build_can_frame(can_id, data)
                if try_send(frame):
                    total_frames += 1
                hex_preview = data[:8].hex(" ").upper()
                suffix = "..." if len(data) > 8 else ""
                print(f"  0x{can_id:03X}  [{len(data):2d}]  {hex_preview}{suffix}  {desc}")
                time.sleep(delay_s)

            # Ramp counter frame — value increments each cycle
            if canfd:
                counter = cycle.to_bytes(2, "big") * 32
                frame = build_canfd_frame(0x7E0, counter)
                dlen = 64
            else:
                counter = cycle.to_bytes(2, "big") * 4
                frame = build_can_frame(0x7E0, counter)
                dlen = 8
            if try_send(frame):
                total_frames += 1
            print(f"  0x7E0  [{dlen:2d}]  Counter = {cycle}")

            time.sleep(cycle_pause_s)

        print(f"\nCompleted {max_cycles} cycle(s).")
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    finally:
        elapsed = time.monotonic() - t_start
        fps = total_frames / elapsed if elapsed > 0 else 0
        total_bytes = total_frames * (CANFD_MTU if canfd else CAN_MTU)
        print(f"Sent {total_frames} frames ({total_bytes} bytes) "
              f"in {elapsed:.1f}s ({fps:.1f} frames/s)")
        if dropped_frames:
            print(f"Dropped {dropped_frames} frame(s) due to ENOBUFS "
                  "(TX buffer full — check bus ACK / listener)")
        if health_stop:
            health_stop.set()
            final_health = _get_bus_health(interface)
            tx_delta = final_health["tx_errors"] - health_baseline["tx_errors"]
            rx_delta = final_health["rx_errors"] - health_baseline["rx_errors"]
            print("\nBus health summary:")
            print(f"  State       : {final_health['state'].upper()}")
            print(f"  TX errors   : {final_health['tx_errors']} (+{tx_delta})")
            print(f"  RX errors   : {final_health['rx_errors']} (+{rx_delta})")
            print(f"  TX dropped  : {final_health['tx_dropped']}")
            if final_health["restarts"] > 0:
                print(f"  Bus restarts: {final_health['restarts']}")
            if tx_delta > 0:
                print("  ** Frames were not ACK'd — check remote node "
                      "bitrate and bus termination **")
        if drain_stop:
            drain_stop.set()
        if drain_sock:
            drain_sock.close()
        sock.close()


def main():
    parser = argparse.ArgumentParser(
        description="CAN / CAN FD test signal generator and monitor",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  sudo %(prog)s --setup                            Setup vcan0 (classic CAN)
  sudo %(prog)s --setup --canfd                    Setup vcan0 with CAN FD MTU
  %(prog)s --send                                  Send classic CAN test frames
  %(prog)s --send --canfd                          Send CAN FD test frames
  %(prog)s --send --canfd --cycles 5               Send 5 cycles then stop
  %(prog)s --send --delay 50 --cycle-pause 500     Faster timing
  %(prog)s --monitor                               Watch frames (like candump)
  %(prog)s --info                                  Show live interface config
  %(prog)s -i can0 --info                          Inspect a physical interface
  sudo %(prog)s --setup --send --canfd             Setup + send CAN FD
  sudo %(prog)s -i can0 --setup --canfd \\
       --bitrate 1000000 --dbitrate 5000000        Physical interface at 1M/5M
  sudo %(prog)s -i vcan1 --setup --send --monitor  Full stack on vcan1
""",
    )

    # Interface and mode
    parser.add_argument("-i", "--interface", default=DEFAULT_INTERFACE,
                        help=f"CAN interface name (default: {DEFAULT_INTERFACE})")
    parser.add_argument("--canfd", action="store_true",
                        help="Use CAN FD (64-byte frames with BRS); default is classic CAN")

    # Actions
    parser.add_argument("--setup", action="store_true",
                        help="Create/configure the CAN interface")
    parser.add_argument("--send", action="store_true",
                        help="Send test frames in a loop")
    parser.add_argument("--monitor", action="store_true",
                        help="Monitor frames on the interface (like candump)")
    parser.add_argument("--info", action="store_true",
                        help="Show live configuration of the interface")

    # Bus speeds (used for physical interfaces during --setup)
    parser.add_argument("--bitrate", type=int, default=DEFAULT_BITRATE,
                        help=f"CAN arbitration bitrate in bps (default: {DEFAULT_BITRATE})")
    parser.add_argument("--dbitrate", type=int, default=DEFAULT_DBITRATE,
                        help=f"CAN FD data bitrate in bps (default: {DEFAULT_DBITRATE})")

    # Timing
    parser.add_argument("--delay", type=int, default=DEFAULT_DELAY,
                        help=f"Delay between frames in ms (default: {DEFAULT_DELAY})")
    parser.add_argument("--cycle-pause", type=int, default=DEFAULT_CYCLE_PAUSE,
                        help=f"Pause between cycles in ms (default: {DEFAULT_CYCLE_PAUSE})")
    parser.add_argument("--cycles", type=int, default=0,
                        help="Number of cycles to send (default: 0 = infinite)")

    args = parser.parse_args()

    if not (args.setup or args.send or args.monitor or args.info):
        parser.print_help()
        sys.exit(1)

    if args.info:
        query_interface_info(args.interface)
        if not (args.setup or args.send or args.monitor):
            return

    print_info(args)

    if args.setup:
        print(f"Setting up {args.interface}...")
        setup_interface(args.interface, args.canfd, args.bitrate, args.dbitrate)

    if args.send and args.monitor:
        pid = os.fork()
        if pid == 0:
            time.sleep(0.3)
            send_test_frames(args.interface, args.canfd, args.delay,
                             args.cycle_pause, args.cycles, has_listener=True)
            sys.exit(0)
        else:
            try:
                monitor(args.interface)
            finally:
                os.kill(pid, 2)  # SIGINT
                os.waitpid(pid, 0)
    elif args.send:
        send_test_frames(args.interface, args.canfd, args.delay,
                         args.cycle_pause, args.cycles, has_listener=False)
    elif args.monitor:
        monitor(args.interface)


if __name__ == "__main__":
    main()
