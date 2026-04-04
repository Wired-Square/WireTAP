#!/usr/bin/env python3
"""
CAN / CAN FD / Serial transport test tool.

Includes both traffic generation (--send, --monitor) and the Test Pattern
protocol for round-trip validation across real hardware.

Test Pattern protocol: see docs/test-pattern-protocol.md

Usage (CAN traffic generation):
    sudo python3 transport_test.py --setup                       # setup classic CAN
    sudo python3 transport_test.py --setup --canfd               # setup with CAN FD MTU
    python3 transport_test.py --send                             # send classic CAN frames
    python3 transport_test.py --send --canfd                     # send CAN FD frames
    python3 transport_test.py --monitor                          # watch frames (like candump)

Usage (Test Pattern — CAN):
    python3 transport_test.py --echo-responder -i can0           # respond to test frames
    python3 transport_test.py --roundtrip -i can0 --rate 100     # initiator ping-pong
    python3 transport_test.py --throughput -i can0 --duration 10 # throughput flood
    python3 transport_test.py --latency -i can0 --duration 30    # latency measurement

Usage (Test Pattern — Serial):
    python3 transport_test.py --serial --echo-responder --port /dev/ttyUSB0
    python3 transport_test.py --serial --roundtrip --port /dev/ttyUSB0 --baud 115200
    python3 transport_test.py --serial --throughput --port /dev/ttyUSB0 --duration 10
    python3 transport_test.py --serial --latency --port /dev/ttyUSB0 --rate 1

Usage (Test Pattern — GVRET TCP client):
    python3 transport_test.py --gvret --echo-responder --host 192.168.1.10
    python3 transport_test.py --gvret --roundtrip --host 192.168.1.10 --rate 100

Usage (Test Pattern — GVRET TCP server, WireTAP connects to us):
    python3 transport_test.py --gvret-listen --echo-responder --host 0.0.0.0
    python3 transport_test.py --gvret-listen --roundtrip --host 0.0.0.0 --rate 100
"""

import argparse
import errno
import json
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

# ---------------------------------------------------------------------------
# Test Pattern protocol constants (see docs/test-pattern-protocol.md)
# ---------------------------------------------------------------------------

# Tags (byte 0)
TP_TAG_PING_REQ      = 0x01
TP_TAG_PING_RESP     = 0x02
TP_TAG_THROUGHPUT     = 0x03
TP_TAG_LATENCY_PROBE  = 0x04
TP_TAG_LATENCY_REPLY  = 0x05
TP_TAG_CONTROL        = 0x06
TP_TAG_STATUS         = 0x07

# CAN frame IDs
TP_ID_PING_REQ       = 0x7F0
TP_ID_PING_RESP      = 0x7F1
TP_ID_THROUGHPUT_TX   = 0x7F2
TP_ID_THROUGHPUT_RX   = 0x7F3
TP_ID_LATENCY_PROBE   = 0x7F4
TP_ID_LATENCY_REPLY   = 0x7F5
TP_ID_CONTROL         = 0x7F6
TP_ID_STATUS          = 0x7F7

TP_IDS = {TP_ID_PING_REQ, TP_ID_PING_RESP, TP_ID_THROUGHPUT_TX, TP_ID_THROUGHPUT_RX,
          TP_ID_LATENCY_PROBE, TP_ID_LATENCY_REPLY, TP_ID_CONTROL, TP_ID_STATUS}

# Tag → response frame ID mapping for the responder
TP_RESPONSE_ID = {
    TP_TAG_PING_REQ: TP_ID_PING_RESP,
    TP_TAG_LATENCY_PROBE: TP_ID_LATENCY_REPLY,
}

# Control command codes (byte 4)
TP_CMD_REQUEST_STATUS = 0x04

# Status report field IDs (byte 2, replaces seq field)
TP_STATUS_RX_COUNT = 0x00
TP_STATUS_TX_COUNT = 0x01
TP_STATUS_DROPS    = 0x02
TP_STATUS_FPS      = 0x03

# Flags (byte 1)
TP_FLAG_BYTES_MODE = 0x01  # bit 0: 0=frames, 1=bytes

# CAN FD fill patterns
TP_PATTERN_SEQUENTIAL  = 0x00
TP_PATTERN_WALKING_BIT = 0x01
TP_PATTERN_COUNTER     = 0x02
TP_PATTERN_ALTERNATING = 0x03
TP_PATTERN_NONE        = 0xFF


# Default serial settings
DEFAULT_SERIAL_PORT = "/dev/ttyUSB0"
DEFAULT_SERIAL_BAUD = 115200


# ---------------------------------------------------------------------------
# COBS codec (for serial bytes-mode framing)
# ---------------------------------------------------------------------------

def cobs_encode(data: bytes) -> bytes:
    """Encode data using Consistent Overhead Byte Stuffing."""
    output = bytearray()
    code_idx = 0
    output.append(0)  # placeholder for first code byte
    code = 1
    for byte in data:
        if byte == 0:
            output[code_idx] = code
            code_idx = len(output)
            output.append(0)
            code = 1
        else:
            output.append(byte)
            code += 1
            if code == 0xFF:
                output[code_idx] = code
                code_idx = len(output)
                output.append(0)
                code = 1
    output[code_idx] = code
    return bytes(output)


def cobs_decode(data: bytes) -> bytes:
    """Decode a COBS-encoded message. Raises ValueError on malformed input."""
    output = bytearray()
    idx = 0
    while idx < len(data):
        code = data[idx]
        if code == 0:
            raise ValueError("Unexpected zero in COBS data")
        idx += 1
        for _ in range(1, code):
            if idx >= len(data):
                raise ValueError("COBS data truncated")
            output.append(data[idx])
            idx += 1
        if code < 0xFF and idx < len(data):
            output.append(0)
    # Remove trailing zero added by the last block
    if output and output[-1] == 0:
        output = output[:-1]
    return bytes(output)


# ---------------------------------------------------------------------------
# SLIP codec (RFC 1055)
# ---------------------------------------------------------------------------

SLIP_END     = 0xC0
SLIP_ESC     = 0xDB
SLIP_ESC_END = 0xDC
SLIP_ESC_ESC = 0xDD


def slip_encode(data: bytes) -> bytes:
    """Encode data using SLIP framing (RFC 1055)."""
    output = bytearray()
    for byte in data:
        if byte == SLIP_END:
            output.append(SLIP_ESC)
            output.append(SLIP_ESC_END)
        elif byte == SLIP_ESC:
            output.append(SLIP_ESC)
            output.append(SLIP_ESC_ESC)
        else:
            output.append(byte)
    output.append(SLIP_END)
    return bytes(output)


def slip_decode(data: bytes) -> bytes:
    """Decode a SLIP-framed message. Raises ValueError on malformed input."""
    output = bytearray()
    i = 0
    while i < len(data):
        byte = data[i]
        if byte == SLIP_END:
            break
        elif byte == SLIP_ESC:
            i += 1
            if i >= len(data):
                raise ValueError("SLIP escape at end of data")
            esc = data[i]
            if esc == SLIP_ESC_END:
                output.append(SLIP_END)
            elif esc == SLIP_ESC_ESC:
                output.append(SLIP_ESC)
            else:
                raise ValueError(f"Invalid SLIP escape sequence: 0xDB 0x{esc:02X}")
        else:
            output.append(byte)
        i += 1
    return bytes(output)


# ---------------------------------------------------------------------------
# Transport abstraction
# ---------------------------------------------------------------------------

class TransportError(Exception):
    """Raised when the transport detects a disconnection or fatal error."""
    pass


class Transport:
    """Abstract base for CAN and serial transports."""

    def send_test_message(self, tag: int, flags: int, seq: int,
                          extra: bytes = b"\x00\x00\x00\x00"):
        raise NotImplementedError

    def recv_test_message(self, timeout: float) -> dict | None:
        """Receive a test message. Returns parsed payload dict or None on timeout.
        Raises TransportError on disconnection."""
        raise NotImplementedError

    def send_status_reports(self, rx_count: int, tx_count: int, drops: int, fps: int):
        """Send a burst of status report frames with the responder's metrics."""
        for field_id, value in [
            (TP_STATUS_RX_COUNT, rx_count),
            (TP_STATUS_TX_COUNT, tx_count),
            (TP_STATUS_DROPS, drops),
            (TP_STATUS_FPS, fps),
        ]:
            payload = tp_build_status_report(field_id, value)
            self._send_raw_payload(payload)

    def _send_raw_payload(self, payload: bytes):
        """Send a pre-built 8-byte payload via the transport's framing."""
        raise NotImplementedError

    def wait_for_reconnect(self) -> bool:
        """Wait for a new connection after a disconnection.
        Returns True if reconnected, False if not supported.
        Only meaningful for server-mode transports."""
        return False

    @property
    def can_reconnect(self) -> bool:
        """Whether this transport supports waiting for reconnection."""
        return False

    def close(self):
        raise NotImplementedError

    @property
    def label(self) -> str:
        return "unknown"


class CANTransport(Transport):
    """Test Pattern transport over SocketCAN."""

    TAG_TO_ID = {
        TP_TAG_PING_REQ: TP_ID_PING_REQ,
        TP_TAG_PING_RESP: TP_ID_PING_RESP,
        TP_TAG_THROUGHPUT: TP_ID_THROUGHPUT_TX,
        TP_TAG_LATENCY_PROBE: TP_ID_LATENCY_PROBE,
        TP_TAG_LATENCY_REPLY: TP_ID_LATENCY_REPLY,
        TP_TAG_CONTROL: TP_ID_CONTROL,
        TP_TAG_STATUS: TP_ID_STATUS,
    }

    def __init__(self, interface: str, canfd: bool):
        self._interface = interface
        self._canfd = canfd
        self._sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW, CAN_RAW)
        if canfd:
            self._sock.setsockopt(socket.SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
        self._sock.bind((interface,))
        self._sock.setblocking(False)

    @property
    def label(self) -> str:
        mode = "CAN FD" if self._canfd else "CAN"
        return f"{mode} on {self._interface}"

    def send_test_message(self, tag, flags, seq, extra=b"\x00\x00\x00\x00"):
        payload = tp_build_payload(tag, flags, seq, extra)
        can_id = self.TAG_TO_ID.get(tag, TP_ID_CONTROL)
        if self._canfd:
            data = payload + b"\x00" * 56
            frame = build_canfd_frame(can_id, data)
        else:
            frame = build_can_frame(can_id, payload)
        try:
            self._sock.send(frame)
        except OSError as e:
            if e.errno == errno.ENOBUFS:
                time.sleep(0.001)
                try:
                    self._sock.send(frame)
                except OSError:
                    pass
            else:
                raise

    def recv_test_message(self, timeout: float) -> dict | None:
        ready, _, _ = select.select([self._sock], [], [], timeout)
        if not ready:
            return None
        raw = self._sock.recv(CANFD_MTU)
        frame_id, dlen, flags, data, is_fd, eff, rtr, err = parse_frame(raw)
        if frame_id not in TP_IDS:
            return None
        parsed = tp_parse_payload(data)
        if parsed:
            parsed["frame_id"] = frame_id
            parsed["is_fd"] = is_fd
            parsed["raw_data"] = data
        return parsed if parsed else None

    def drain_messages(self, timeout: float = 0.0):
        """Read and discard all pending messages (non-blocking)."""
        while True:
            ready, _, _ = select.select([self._sock], [], [], timeout)
            if not ready:
                break
            try:
                self._sock.recv(CANFD_MTU)
            except OSError:
                break

    def _send_raw_payload(self, payload: bytes):
        frame = build_can_frame(TP_ID_STATUS, payload) if not self._canfd else build_canfd_frame(TP_ID_STATUS, payload + b"\x00" * 56)
        try:
            self._sock.send(frame)
        except OSError:
            pass

    def close(self):
        self._sock.close()


# DLC to payload length lookup (CAN FD)
GVRET_DLC_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]


class GVRETTransport(Transport):
    """Test Pattern transport over GVRET TCP (binary protocol).

    Supports two modes:
    - Client (default): connects to a GVRET device at host:port, sends binary
      mode init, queries bus count.
    - Server (--gvret-listen): binds to a port and waits for a client (e.g.
      WireTAP) to connect. Responds to GVRET init commands (bus count query,
      device info probe) so WireTAP treats it as a real GVRET device.
    """

    SYNC = 0xF1
    CMD_CAN_FRAME = 0x00
    CMD_TIME_SYNC = 0x01
    CMD_GET_CANBUS_PARAMS = 0x06
    CMD_GET_DEV_INFO = 0x07
    CMD_KEEPALIVE = 0x09
    CMD_GET_NUMBUSES = 0x0C

    TAG_TO_ID = {
        TP_TAG_PING_REQ: TP_ID_PING_REQ,
        TP_TAG_PING_RESP: TP_ID_PING_RESP,
        TP_TAG_THROUGHPUT: TP_ID_THROUGHPUT_TX,
        TP_TAG_LATENCY_PROBE: TP_ID_LATENCY_PROBE,
        TP_TAG_LATENCY_REPLY: TP_ID_LATENCY_REPLY,
        TP_TAG_CONTROL: TP_ID_CONTROL,
        TP_TAG_STATUS: TP_ID_STATUS,
    }

    def __init__(self, host: str, port: int, bus: int = 0, listen: bool = False,
                 num_buses: int = 1):
        self._host = host
        self._port = port
        self._bus = bus
        self._rx_buf = bytearray()
        self._num_buses = num_buses
        self._listen = listen
        self._server_sock: socket.socket | None = None

        if listen:
            self._sock = self._start_server(host, port)
        else:
            self._sock = self._connect_client(host, port)

    def _connect_client(self, host: str, port: int) -> socket.socket:
        """Connect as a GVRET TCP client."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3.0)
        try:
            sock.connect((host, port))
        except (ConnectionRefusedError, OSError) as e:
            print(f"ERROR: Cannot connect to GVRET device at {host}:{port}: {e}",
                  file=sys.stderr)
            sys.exit(1)

        # Initialise binary mode
        sock.sendall(bytes([0xE7, 0xE7]))
        time.sleep(0.05)

        # Query bus count
        sock.sendall(bytes([self.SYNC, self.CMD_GET_NUMBUSES]))
        time.sleep(0.1)

        # Try to read bus count response
        sock.setblocking(False)
        try:
            data = sock.recv(256)
            self._rx_buf.extend(data)
            for i in range(len(self._rx_buf) - 2):
                if (self._rx_buf[i] == self.SYNC
                        and self._rx_buf[i + 1] == self.CMD_GET_NUMBUSES):
                    self._num_buses = self._rx_buf[i + 2]
                    self._rx_buf = self._rx_buf[i + 3:]
                    break
        except BlockingIOError:
            pass

        print(f"  GVRET client connected to {host}:{port}"
              f" ({self._num_buses} bus{'es' if self._num_buses != 1 else ''})")
        return sock

    def _start_server(self, host: str, port: int) -> socket.socket:
        """Listen as a GVRET TCP server, wait for one client."""
        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        bind_addr = host if host != "0.0.0.0" else ""
        self._server_sock.bind((bind_addr, port))
        self._server_sock.listen(1)
        print(f"  GVRET server listening on {host}:{port}"
              f" ({self._num_buses} bus{'es' if self._num_buses != 1 else ''})")
        print("  Waiting for client connection...")

        conn, addr = self._server_sock.accept()
        print(f"  Client connected from {addr[0]}:{addr[1]}")

        # Handle client initialisation (binary mode enable, probes)
        conn.setblocking(False)
        time.sleep(0.2)  # Let client send init bytes
        self._handle_client_init(conn)

        return conn

    def _handle_client_init(self, conn: socket.socket):
        """Process GVRET init commands from the client and respond."""
        try:
            data = conn.recv(256)
            if data:
                self._rx_buf.extend(data)
        except BlockingIOError:
            pass

        # Strip binary mode enable bytes (0xE7)
        while self._rx_buf and self._rx_buf[0] == 0xE7:
            self._rx_buf.pop(0)

        # Process any init commands in the buffer
        self._answer_control_commands(conn)

    def _answer_control_commands(self, conn: socket.socket):
        """Scan the rx buffer for GVRET control commands and send responses."""
        while True:
            try:
                idx = self._rx_buf.index(self.SYNC)
            except ValueError:
                self._rx_buf.clear()
                return

            if idx > 0:
                self._rx_buf = self._rx_buf[idx:]

            if len(self._rx_buf) < 2:
                return

            cmd = self._rx_buf[1]

            if cmd == self.CMD_GET_NUMBUSES:
                # Respond with bus count
                conn.sendall(bytes([self.SYNC, self.CMD_GET_NUMBUSES,
                                    self._num_buses & 0xFF]))
                self._rx_buf = self._rx_buf[2:]

            elif cmd == self.CMD_GET_DEV_INFO:
                # Respond with dummy device info:
                # F1 07 build:2LE eeprom_ver file_out_type auto_log singlewire
                conn.sendall(bytes([self.SYNC, self.CMD_GET_DEV_INFO,
                                    0x01, 0x00, 0x01, 0x00, 0x00, 0x00]))
                self._rx_buf = self._rx_buf[2:]

            elif cmd == self.CMD_GET_CANBUS_PARAMS:
                # Respond with dummy CAN params (500 kbps on each bus)
                resp = bytearray([self.SYNC, self.CMD_GET_CANBUS_PARAMS])
                for _ in range(self._num_buses):
                    resp.append(0x01)  # flags (enabled)
                    resp.extend(struct.pack("<I", 500000))  # speed
                conn.sendall(bytes(resp))
                self._rx_buf = self._rx_buf[2:]

            elif cmd == self.CMD_TIME_SYNC:
                # Respond with timestamp
                ts = int(time.monotonic() * 1_000_000) & 0xFFFFFFFF
                conn.sendall(bytes([self.SYNC, self.CMD_TIME_SYNC])
                             + struct.pack("<I", ts))
                self._rx_buf = self._rx_buf[2:]

            elif cmd == self.CMD_CAN_FRAME:
                # This is a data frame from the client — stop processing init
                return

            else:
                # Unknown command, skip sync byte and resync
                self._rx_buf = self._rx_buf[1:]

    @property
    def label(self) -> str:
        mode = "server" if self._listen else "client"
        return f"GVRET TCP {mode} {self._host}:{self._port} bus {self._bus}"

    def _encode_client_tx_frame(self, frame_id: int, data: bytes, bus: int,
                               is_extended: bool) -> bytes:
        """Encode a CAN frame in client TX format: F1 00 [id:4LE] [bus] [len] [data]."""
        fid = frame_id & 0x1FFFFFFF
        if is_extended:
            fid |= 0x80000000
        out = bytearray()
        out.append(self.SYNC)
        out.append(self.CMD_CAN_FRAME)
        out.extend(struct.pack("<I", fid))
        out.append(bus & 0xFF)
        out.append(len(data) & 0xFF)
        out.extend(data)
        return bytes(out)

    def _encode_device_rx_frame(self, frame_id: int, data: bytes, bus: int,
                                is_extended: bool) -> bytes:
        """Encode a CAN frame in device RX format: F1 00 [ts:4LE] [id:4LE] [bus_dlc:1] [data] [cksum].
        Used in server mode so clients (e.g. WireTAP) can parse the frame."""
        fid = frame_id & 0x1FFFFFFF
        if is_extended:
            fid |= 0x80000000
        ts = int(time.monotonic() * 1_000_000) & 0xFFFFFFFF
        dlc = len(data)
        bus_dlc = ((bus & 0x0F) << 4) | (dlc & 0x0F)
        out = bytearray()
        out.append(self.SYNC)
        out.append(self.CMD_CAN_FRAME)
        out.extend(struct.pack("<I", ts))
        out.extend(struct.pack("<I", fid))
        out.append(bus_dlc)
        out.extend(data)
        out.append(0x00)  # checksum
        return bytes(out)

    def _try_parse_rx_frame(self) -> dict | None:
        """Try to parse a GVRET CAN frame from the receive buffer.
        Returns parsed test payload dict, or None if no complete frame available.

        In client mode, incoming frames use the device RX format:
            F1 00 [ts:4LE] [id:4LE] [bus_dlc:1] [data:N] [checksum:1]
        In server mode, incoming frames use the client TX format:
            F1 00 [id:4LE] [bus:1] [len:1] [data:N]
        """
        while True:
            # Strip any leading 0xE7 binary mode enable bytes
            while self._rx_buf and self._rx_buf[0] == 0xE7:
                self._rx_buf.pop(0)

            # Find sync byte
            try:
                sync_idx = self._rx_buf.index(self.SYNC)
            except ValueError:
                self._rx_buf.clear()
                return None

            if sync_idx > 0:
                self._rx_buf = self._rx_buf[sync_idx:]

            if len(self._rx_buf) < 2:
                return None

            cmd = self._rx_buf[1]

            if cmd == self.CMD_CAN_FRAME:
                if self._listen:
                    result = self._parse_tx_format_frame()
                else:
                    result = self._parse_rx_format_frame()
                if result is None:
                    return None  # Incomplete, need more data
                if result == "skip":
                    continue  # Non-test-pattern frame, skip
                return result

            elif cmd == self.CMD_KEEPALIVE:
                if len(self._rx_buf) < 4:
                    return None
                self._rx_buf = self._rx_buf[4:]
                continue

            elif cmd in (self.CMD_GET_NUMBUSES, self.CMD_GET_DEV_INFO,
                         self.CMD_GET_CANBUS_PARAMS, self.CMD_TIME_SYNC):
                if self._listen:
                    # Server mode: answer the control command
                    self._answer_control_commands(self._sock)
                else:
                    # Client mode: skip control responses
                    skip_lens = {
                        self.CMD_TIME_SYNC: 6,
                        self.CMD_GET_CANBUS_PARAMS: 12,
                        self.CMD_GET_DEV_INFO: 8,
                        self.CMD_GET_NUMBUSES: 3,
                    }
                    skip = skip_lens.get(cmd, 3)
                    if len(self._rx_buf) < skip:
                        return None
                    self._rx_buf = self._rx_buf[skip:]
                continue

            else:
                self._rx_buf = self._rx_buf[1:]
                continue

    def _parse_rx_format_frame(self):
        """Parse device RX format: F1 00 [ts:4] [id:4] [bus_dlc:1] [data:N] [cksum:1].
        Returns parsed dict, 'skip' for non-TP frames, or None if incomplete."""
        if len(self._rx_buf) < 11:
            return None

        bus_dlc = self._rx_buf[10]
        dlc = bus_dlc & 0x0F
        rx_bus = (bus_dlc >> 4) & 0x0F
        payload_len = GVRET_DLC_LEN[dlc] if dlc < 16 else 0
        frame_len = 11 + payload_len + 1

        if len(self._rx_buf) < frame_len:
            return None

        frame_bytes = bytes(self._rx_buf[:frame_len])
        self._rx_buf = self._rx_buf[frame_len:]

        fid_raw = struct.unpack_from("<I", frame_bytes, 6)[0]
        frame_id = fid_raw & 0x1FFFFFFF
        data = frame_bytes[11:11 + payload_len]

        if frame_id not in TP_IDS:
            return "skip"

        parsed = tp_parse_payload(data)
        if parsed:
            parsed["frame_id"] = frame_id
            parsed["is_fd"] = dlc > 8
            parsed["raw_data"] = data
            parsed["bus"] = rx_bus
        return parsed if parsed else "skip"

    def _parse_tx_format_frame(self):
        """Parse client TX format: F1 00 [id:4LE] [bus:1] [len:1] [data:N].
        Returns parsed dict, 'skip' for non-TP frames, or None if incomplete."""
        if len(self._rx_buf) < 8:
            return None

        data_len = self._rx_buf[7]
        frame_len = 8 + data_len

        if len(self._rx_buf) < frame_len:
            return None

        frame_bytes = bytes(self._rx_buf[:frame_len])
        self._rx_buf = self._rx_buf[frame_len:]

        fid_raw = struct.unpack_from("<I", frame_bytes, 2)[0]
        frame_id = fid_raw & 0x1FFFFFFF
        rx_bus = frame_bytes[6]
        data = frame_bytes[8:8 + data_len]

        if frame_id not in TP_IDS:
            return "skip"

        parsed = tp_parse_payload(data)
        if parsed:
            parsed["frame_id"] = frame_id
            parsed["is_fd"] = data_len > 8
            parsed["raw_data"] = data
            parsed["bus"] = rx_bus
        return parsed if parsed else "skip"

    def send_test_message(self, tag, flags, seq, extra=b"\x00\x00\x00\x00"):
        payload = tp_build_payload(tag, flags, seq, extra)
        can_id = self.TAG_TO_ID.get(tag, TP_ID_CONTROL)
        is_extended = False
        if self._listen:
            # Server: encode as device RX format so clients can parse it
            frame = self._encode_device_rx_frame(can_id, payload, self._bus, is_extended)
        else:
            # Client: encode as client TX format
            frame = self._encode_client_tx_frame(can_id, payload, self._bus, is_extended)
        try:
            self._sock.sendall(frame)
        except BrokenPipeError:
            raise TransportError("GVRET TCP connection lost (broken pipe)")
        except ConnectionResetError:
            raise TransportError("GVRET TCP connection reset by peer")
        except OSError as e:
            raise TransportError(f"GVRET TCP send error: {e}")

    def recv_test_message(self, timeout: float) -> dict | None:
        # First check if we already have a parseable frame buffered
        result = self._try_parse_rx_frame()
        if result is not None:
            return result

        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _, _ = select.select([self._sock], [], [], min(remaining, 0.05))
            if ready:
                try:
                    chunk = self._sock.recv(4096)
                    if not chunk:
                        raise TransportError("GVRET TCP connection closed by peer")
                    self._rx_buf.extend(chunk)
                except TransportError:
                    raise
                except ConnectionResetError:
                    raise TransportError("GVRET TCP connection reset by peer")
                except OSError as e:
                    raise TransportError(f"GVRET TCP recv error: {e}")

                result = self._try_parse_rx_frame()
                if result is not None:
                    return result

    @property
    def can_reconnect(self) -> bool:
        return self._listen

    def wait_for_reconnect(self) -> bool:
        """Close the current client connection and wait for a new one."""
        if not self._listen or not self._server_sock:
            return False

        try:
            self._sock.close()
        except OSError:
            pass

        self._rx_buf.clear()

        print(f"\n  Waiting for new client connection on port {self._port}...")
        try:
            conn, addr = self._server_sock.accept()
            print(f"  Client connected from {addr[0]}:{addr[1]}")
            conn.setblocking(False)
            time.sleep(0.2)
            self._sock = conn
            self._handle_client_init(conn)
            return True
        except OSError as e:
            print(f"  Accept failed: {e}", file=sys.stderr)
            return False

    def _send_raw_payload(self, payload: bytes):
        is_extended = False
        if self._listen:
            frame = self._encode_device_rx_frame(TP_ID_STATUS, payload, self._bus, is_extended)
        else:
            frame = self._encode_client_tx_frame(TP_ID_STATUS, payload, self._bus, is_extended)
        try:
            self._sock.sendall(frame)
        except OSError:
            pass

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass
        if self._server_sock:
            try:
                self._server_sock.close()
            except OSError:
                pass


class SerialTransport(Transport):
    """Test Pattern transport over serial with configurable framing (COBS or SLIP)."""

    def __init__(self, port: str, baud: int, framing: str = "cobs"):
        try:
            import serial as pyserial
        except ImportError:
            print("ERROR: pyserial is required for serial transport.", file=sys.stderr)
            print("  Install with: pip install pyserial", file=sys.stderr)
            sys.exit(1)
        self._port_name = port
        self._baud = baud
        self._framing = framing
        self._ser = pyserial.Serial(port, baud, timeout=0)
        self._rx_buf = bytearray()

        if framing == "cobs":
            self._encode = cobs_encode
            self._decode = cobs_decode
            self._delimiter = b"\x00"
            self._delim_byte = 0x00
        elif framing == "slip":
            self._encode = slip_encode
            self._decode = slip_decode
            self._delimiter = b""  # SLIP_END is appended by slip_encode
            self._delim_byte = SLIP_END
        else:
            raise ValueError(f"Unknown framing: {framing}")

    @property
    def label(self) -> str:
        return f"Serial {self._port_name} @ {self._baud} ({self._framing})"

    def send_test_message(self, tag, flags, seq, extra=b"\x00\x00\x00\x00"):
        flags = flags | TP_FLAG_BYTES_MODE
        payload = tp_build_payload(tag, flags, seq, extra)
        encoded = self._encode(payload) + self._delimiter
        self._ser.write(encoded)

    def recv_test_message(self, timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        delim = self._delim_byte
        while True:
            # Check if we have a complete frame in the buffer
            try:
                delim_idx = self._rx_buf.index(delim)
            except ValueError:
                delim_idx = -1

            if delim_idx >= 0:
                raw_frame = bytes(self._rx_buf[:delim_idx])
                self._rx_buf = self._rx_buf[delim_idx + 1:]
                if len(raw_frame) == 0:
                    continue
                try:
                    data = self._decode(raw_frame)
                except ValueError:
                    continue
                parsed = tp_parse_payload(data)
                return parsed if parsed else None

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self._ser.timeout = min(remaining, 0.05)
            chunk = self._ser.read(256)
            if chunk:
                self._rx_buf.extend(chunk)
            elif time.monotonic() >= deadline:
                return None

    def _send_raw_payload(self, payload: bytes):
        encoded = self._encode(payload) + self._delimiter
        self._ser.write(encoded)

    def close(self):
        self._ser.close()


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


# ---------------------------------------------------------------------------
# Test Pattern protocol helpers
# ---------------------------------------------------------------------------

def tp_build_payload(tag: int, flags: int, seq: int, extra: bytes = b"\x00\x00\x00\x00") -> bytes:
    """Build an 8-byte Test Pattern payload."""
    return struct.pack(">BBH", tag, flags, seq) + extra[:4].ljust(4, b"\x00")


def tp_parse_payload(data: bytes) -> dict:
    """Parse an 8-byte Test Pattern payload into its fields."""
    if len(data) < 8:
        return {}
    tag, flags, seq = struct.unpack_from(">BBH", data, 0)
    extra = data[4:8]
    return {"tag": tag, "flags": flags, "seq": seq, "extra": extra}


def tp_build_status_report(field_id: int, value: int, flags: int = 0) -> bytes:
    """Build an 8-byte status report payload.
    Byte 0: tag (0x07), Byte 1: flags, Bytes 2-3: seq (unused, 0),
    Byte 4: field_id, Bytes 5-7: value (big-endian u24).
    This layout matches tp_parse_payload where bytes 4-7 = extra."""
    extra = struct.pack(">B", field_id) + struct.pack(">I", value & 0xFFFFFF)[1:]
    return tp_build_payload(TP_TAG_STATUS, flags, 0, extra)


def tp_build_canfd_fill(pattern_id: int, seq: int, length: int = 56) -> bytes:
    """Build CAN FD fill bytes (bytes 8-63) for a given pattern."""
    if pattern_id == TP_PATTERN_SEQUENTIAL:
        return bytes(i & 0xFF for i in range(length))
    elif pattern_id == TP_PATTERN_WALKING_BIT:
        walk = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
        return bytes(walk[i % 8] for i in range(length))
    elif pattern_id == TP_PATTERN_COUNTER:
        return bytes([seq & 0xFF] * length)
    elif pattern_id == TP_PATTERN_ALTERNATING:
        return bytes([0xAA, 0x55] * (length // 2))
    else:
        return b"\x00" * length


def tp_verify_canfd_fill(data: bytes, pattern_id: int, seq: int) -> bool:
    """Verify CAN FD fill bytes (bytes 8+) match the expected pattern."""
    if len(data) <= 8:
        return True
    fill = data[8:]
    expected = tp_build_canfd_fill(pattern_id, seq, len(fill))
    return fill == expected


def tp_timestamp_us() -> int:
    """Return current monotonic time as microseconds (low 32 bits)."""
    return int(time.monotonic() * 1_000_000) & 0xFFFFFFFF


class SequenceTracker:
    """Tracks received sequence numbers to detect drops, duplicates, and reordering."""

    def __init__(self):
        self.expected = 0
        self.rx_count = 0
        self.drops = 0
        self.duplicates = 0
        self.out_of_order = 0
        self.gaps: list[tuple[int, int]] = []  # (expected, received)
        self._seen = set()

    def track(self, seq: int):
        self.rx_count += 1

        if seq == self.expected:
            # Normal
            self._advance()
        elif seq > self.expected:
            # Gap — frames were dropped
            gap_size = seq - self.expected
            # Handle wrap: if gap is huge, it's likely reordering not a real gap
            if gap_size > 32768:
                self.out_of_order += 1
            else:
                self.drops += gap_size
                self.gaps.append((self.expected, seq))
                self.expected = (seq + 1) & 0xFFFF
        elif seq < self.expected:
            # Could be wrap or out-of-order
            if self.expected - seq > 32768:
                # Wrap: expected is near 65535, seq is near 0
                gap_size = (65536 - self.expected) + seq
                if gap_size > 1:
                    self.drops += gap_size - 1
                    self.gaps.append((self.expected, seq))
                self.expected = (seq + 1) & 0xFFFF
            else:
                self.out_of_order += 1

        if seq in self._seen:
            self.duplicates += 1
        self._seen.add(seq)
        # Limit memory for long runs
        if len(self._seen) > 70000:
            self._seen.clear()

    def _advance(self):
        self.expected = (self.expected + 1) & 0xFFFF

    def summary(self) -> dict:
        return {
            "rx_count": self.rx_count,
            "drops": self.drops,
            "duplicates": self.duplicates,
            "out_of_order": self.out_of_order,
            "sequence_gaps": [{"expected": e, "received": r} for e, r in self.gaps],
        }


class LatencyTracker:
    """Collects RTT samples and computes statistics."""

    def __init__(self):
        self.samples: list[int] = []

    def record(self, rtt_us: int):
        self.samples.append(rtt_us)

    def summary(self) -> dict | None:
        if not self.samples:
            return None
        s = sorted(self.samples)
        n = len(s)
        return {
            "min": s[0],
            "max": s[-1],
            "mean": sum(s) // n,
            "p50": s[n // 2],
            "p95": s[int(n * 0.95)],
            "p99": s[int(n * 0.99)],
            "count": n,
        }


_TAG_NAMES = {
    TP_TAG_PING_REQ: "ping",
    TP_TAG_PING_RESP: "ping-resp",
    TP_TAG_THROUGHPUT: "throughput",
    TP_TAG_LATENCY_PROBE: "latency",
    TP_TAG_LATENCY_REPLY: "latency-resp",
    TP_TAG_CONTROL: "control",
    TP_TAG_STATUS: "status",
}


def echo_responder(transport: Transport):
    """Run as responder: reply to ping requests and latency probes.
    In server mode, waits for a new client after disconnection."""
    print(f"Test Pattern echo responder on {transport.label} — Ctrl+C to stop")
    print()

    total_rx = 0
    total_tx = 0
    session = 0

    try:
        while True:
            session += 1
            rx_count = 0
            tx_count = 0
            ping_count = 0
            latency_count = 0
            throughput_count = 0
            corruption_count = 0
            first_frame_time: float | None = None
            last_rx_time: float | None = None
            t_start = time.monotonic()
            last_report = t_start
            idle_reported = False
            prev_report_rx = 0
            IDLE_RESET_SEC = 3.0  # reset fps baseline after this much inactivity

            if session > 1:
                print(f"\n--- Session {session} ---\n")

            try:
                while True:
                    parsed = transport.recv_test_message(timeout=1.0)
                    now = time.monotonic()

                    if parsed is None:
                        if now - last_report >= 5.0:
                            elapsed = now - t_start
                            if rx_count == 0:
                                if not idle_reported:
                                    print(f"  [{elapsed:.0f}s] Waiting for frames...")
                                    idle_reported = True
                            elif rx_count == prev_report_rx:
                                # No new frames since last report — test likely ended
                                if not idle_reported:
                                    print(f"  [{elapsed:.0f}s] Idle (test ended?)"
                                          f"  RX: {rx_count}  TX: {tx_count}")
                                    idle_reported = True
                            else:
                                active = now - first_frame_time if first_frame_time else 0
                                fps = rx_count / active if active > 0 else 0
                                print(f"  [{elapsed:.0f}s] RX: {rx_count}  TX: {tx_count}  "
                                      f"({fps:.0f} fps)  "
                                      f"ping: {ping_count}  latency: {latency_count}  "
                                      f"throughput: {throughput_count}")
                                idle_reported = False
                            prev_report_rx = rx_count
                            last_report = now
                        continue

                    # First frame or resuming after idle — reset fps baseline
                    is_first = rx_count == 0
                    is_idle_resume = (last_rx_time is not None
                                      and (now - last_rx_time) > IDLE_RESET_SEC)
                    if is_first or is_idle_resume:
                        elapsed = now - t_start
                        tag_name = _TAG_NAMES.get(parsed["tag"], f"0x{parsed['tag']:02X}")
                        if is_first:
                            print(f"  [{elapsed:.0f}s] First frame received (type: {tag_name}, "
                                  f"seq: {parsed['seq']})")
                        else:
                            print(f"  [{elapsed:.0f}s] Frames resumed (type: {tag_name}, "
                                  f"seq: {parsed['seq']})")
                        first_frame_time = now
                        rx_count = 0
                        tx_count = 0
                        ping_count = 0
                        latency_count = 0
                        throughput_count = 0
                    last_rx_time = now

                    rx_count += 1
                    tag = parsed["tag"]

                    if tag == TP_TAG_PING_REQ:
                        try:
                            transport.send_test_message(TP_TAG_PING_RESP, parsed["flags"], parsed["seq"])
                            tx_count += 1
                            ping_count += 1
                        except TransportError:
                            raise
                        except OSError as e:
                            print(f"  TX error (ping reply seq {parsed['seq']}): {e}", file=sys.stderr)

                    elif tag == TP_TAG_LATENCY_PROBE:
                        try:
                            transport.send_test_message(TP_TAG_LATENCY_REPLY, parsed["flags"],
                                                        parsed["seq"], parsed["extra"])
                            tx_count += 1
                            latency_count += 1
                        except TransportError:
                            raise
                        except OSError as e:
                            print(f"  TX error (latency reply seq {parsed['seq']}): {e}", file=sys.stderr)

                    elif tag == TP_TAG_THROUGHPUT:
                        throughput_count += 1
                        raw_data = parsed.get("raw_data")
                        if raw_data and parsed.get("is_fd") and len(raw_data) > 8:
                            pattern_id = parsed["extra"][0]
                            if not tp_verify_canfd_fill(raw_data, pattern_id, parsed["seq"]):
                                corruption_count += 1
                                if corruption_count <= 5:
                                    print(f"  *** Data corruption at seq {parsed['seq']} ***")
                                elif corruption_count == 6:
                                    print("  *** Further corruption errors suppressed ***")

                    elif tag == TP_TAG_CONTROL:
                        cmd = parsed["extra"][0]
                        if cmd == TP_CMD_REQUEST_STATUS:
                            active = now - first_frame_time if first_frame_time else 0
                            current_fps = int(rx_count / active) if active > 0 else 0
                            elapsed = now - t_start
                            print(f"  [{elapsed:.0f}s] Status requested — "
                                  f"sending RX={rx_count} TX={tx_count} fps={current_fps}")
                            try:
                                transport.send_status_reports(
                                    rx_count=rx_count,
                                    tx_count=tx_count,
                                    drops=0,
                                    fps=current_fps,
                                )
                            except (TransportError, OSError):
                                pass
                            # Don't count control frames in rx_count
                            rx_count -= 1

                    if now - last_report >= 5.0:
                        elapsed = now - t_start
                        active = now - first_frame_time if first_frame_time else 0
                        fps = rx_count / active if active > 0 else 0
                        print(f"  [{elapsed:.0f}s] RX: {rx_count}  TX: {tx_count}  "
                              f"({fps:.0f} fps)  "
                              f"ping: {ping_count}  latency: {latency_count}  "
                              f"throughput: {throughput_count}")
                        last_report = now

            except TransportError as e:
                elapsed = time.monotonic() - t_start
                total_rx += rx_count
                total_tx += tx_count
                print(f"\n  Client disconnected: {e}")
                _print_responder_summary(rx_count, tx_count, elapsed,
                                         ping_count, latency_count, throughput_count,
                                         corruption_count)

                if transport.can_reconnect:
                    if not transport.wait_for_reconnect():
                        break
                    continue
                else:
                    break

    except KeyboardInterrupt:
        elapsed = time.monotonic() - t_start
        total_rx += rx_count
        total_tx += tx_count
        print()
        _print_responder_summary(rx_count, tx_count, elapsed,
                                 ping_count, latency_count, throughput_count,
                                 corruption_count)

    if session > 1:
        print(f"\n  Total across {session} session(s): RX={total_rx} TX={total_tx}")
    print("Stopped.")
    transport.close()


def _print_responder_summary(rx_count: int, tx_count: int, elapsed: float,
                              ping_count: int, latency_count: int,
                              throughput_count: int, corruption_count: int):
    """Print a summary table for an echo responder session."""
    fps = rx_count / elapsed if elapsed > 0 else 0
    print("  " + "-" * 40)
    print(f"  Duration      : {elapsed:.1f}s")
    print(f"  RX total      : {rx_count} ({fps:.0f} fps)")
    print(f"  TX replies    : {tx_count}")
    if ping_count:
        print(f"    Ping        : {ping_count}")
    if latency_count:
        print(f"    Latency     : {latency_count}")
    if throughput_count:
        print(f"    Throughput  : {throughput_count} (rx only, no reply)")
    if corruption_count:
        print(f"  *** Corruption: {corruption_count} frames ***")
    print("  " + "-" * 40)


def roundtrip_test(transport: Transport, rate_hz: float, duration_sec: float,
                   json_report: str | None):
    """Run as initiator: send pings, track responses, measure drops."""
    interval = 1.0 / rate_hz if rate_hz > 0 else 0.01
    seq_tracker = SequenceTracker()
    latency_tracker = LatencyTracker()
    tx_count = 0
    seq = 0
    pending: dict[int, int] = {}

    print(f"Test Pattern roundtrip on {transport.label} — {rate_hz} Hz for {duration_sec}s")
    print()

    t_start = time.monotonic()
    next_send = t_start
    last_report = t_start

    try:
        while True:
            now = time.monotonic()
            if now - t_start >= duration_sec:
                break

            if now >= next_send:
                ts_us = tp_timestamp_us()
                transport.send_test_message(TP_TAG_PING_REQ, 0x00, seq)
                pending[seq] = ts_us
                tx_count += 1
                seq = (seq + 1) & 0xFFFF
                next_send += interval

            # Check for responses
            recv_timeout = max(0, min(next_send - time.monotonic(), 0.001))
            parsed = transport.recv_test_message(timeout=recv_timeout)
            if parsed and parsed["tag"] == TP_TAG_PING_RESP:
                resp_seq = parsed["seq"]
                seq_tracker.track(resp_seq)
                if resp_seq in pending:
                    rtt = (tp_timestamp_us() - pending.pop(resp_seq)) & 0xFFFFFFFF
                    latency_tracker.record(rtt)

            if now - last_report >= 2.0:
                elapsed = now - t_start
                print(f"  [{elapsed:.0f}s] TX: {tx_count}  RX: {seq_tracker.rx_count}  "
                      f"Drops: {seq_tracker.drops}")
                last_report = now

    except TransportError as e:
        print(f"\n  *** DISCONNECTED: {e} ***")
        if transport.can_reconnect and transport.wait_for_reconnect():
            print("  Reconnected — but roundtrip test is complete for this run.")
    except KeyboardInterrupt:
        print("\nInterrupted.")

    # Wait briefly for trailing responses (skip if disconnected)
    try:
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            parsed = transport.recv_test_message(timeout=0.1)
            if parsed and parsed["tag"] == TP_TAG_PING_RESP:
                resp_seq = parsed["seq"]
                seq_tracker.track(resp_seq)
                if resp_seq in pending:
                    rtt = (tp_timestamp_us() - pending.pop(resp_seq)) & 0xFFFFFFFF
                    latency_tracker.record(rtt)
            elif parsed is None:
                break
    except TransportError:
        pass

    transport.close()

    elapsed = time.monotonic() - t_start
    seq_tracker.drops += len(pending)

    lat = latency_tracker.summary()
    summary = seq_tracker.summary()

    print()
    print("=" * 60)
    print("  Roundtrip Results")
    print("=" * 60)
    print(f"  Transport    : {transport.label}")
    print(f"  Duration     : {elapsed:.1f}s")
    print(f"  TX           : {tx_count}")
    print(f"  RX           : {summary['rx_count']}")
    print(f"  Drops        : {summary['drops']}")
    print(f"  Duplicates   : {summary['duplicates']}")
    print(f"  Out-of-order : {summary['out_of_order']}")
    if lat:
        print(f"  RTT min      : {lat['min']} us")
        print(f"  RTT max      : {lat['max']} us")
        print(f"  RTT mean     : {lat['mean']} us")
        print(f"  RTT p50      : {lat['p50']} us")
        print(f"  RTT p95      : {lat['p95']} us")
        print(f"  RTT p99      : {lat['p99']} us")
    passed = summary["drops"] == 0 and summary["duplicates"] == 0
    print(f"  Result       : {'PASS' if passed else 'FAIL'}")
    print("=" * 60)

    if json_report:
        report = {
            "test_mode": "roundtrip",
            "transport": transport.label,
            "duration_sec": round(elapsed, 1),
            "rate_hz": rate_hz,
            "tx_count": tx_count,
            **summary,
            "latency_us": lat,
            "errors": [],
            "pass": passed,
        }
        with open(json_report, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nReport written to {json_report}")


def throughput_test(transport: Transport, duration_sec: float, json_report: str | None):
    """Run as initiator: flood throughput frames as fast as possible."""
    print(f"Test Pattern throughput flood on {transport.label} for {duration_sec}s")
    print()

    tx_count = 0
    seq = 0
    t_start = time.monotonic()
    last_report = t_start

    try:
        while True:
            now = time.monotonic()
            if now - t_start >= duration_sec:
                break

            extra = struct.pack(">B3x", TP_PATTERN_NONE)
            transport.send_test_message(TP_TAG_THROUGHPUT, 0x00, seq, extra)
            tx_count += 1
            seq = (seq + 1) & 0xFFFF

            if now - last_report >= 2.0:
                elapsed = now - t_start
                fps = tx_count / elapsed if elapsed > 0 else 0
                print(f"  [{elapsed:.0f}s] TX: {tx_count}  ({fps:.0f} fps)")
                last_report = now

    except TransportError as e:
        print(f"\n  *** DISCONNECTED: {e} ***")
        if transport.can_reconnect and transport.wait_for_reconnect():
            print("  Reconnected — but throughput test is complete for this run.")
    except KeyboardInterrupt:
        print("\nInterrupted.")

    transport.close()

    elapsed = time.monotonic() - t_start
    fps = tx_count / elapsed if elapsed > 0 else 0

    print()
    print("=" * 60)
    print("  Throughput Results")
    print("=" * 60)
    print(f"  Transport    : {transport.label}")
    print(f"  Duration     : {elapsed:.1f}s")
    print(f"  TX messages  : {tx_count}")
    print(f"  Rate         : {fps:.0f} msg/sec")
    print(f"  Data rate    : {fps * 8 / 1024:.1f} KB/s")
    print("=" * 60)

    if json_report:
        report = {
            "test_mode": "throughput",
            "transport": transport.label,
            "duration_sec": round(elapsed, 1),
            "tx_count": tx_count,
            "messages_per_sec": round(fps, 1),
            "data_rate_kbps": round(fps * 8 / 1024, 1),
            "errors": [],
        }
        with open(json_report, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nReport written to {json_report}")


def latency_test(transport: Transport, rate_hz: float, duration_sec: float,
                 json_report: str | None):
    """Run as initiator: send latency probes, measure RTT."""
    interval = 1.0 / rate_hz if rate_hz > 0 else 1.0
    latency_tracker = LatencyTracker()
    tx_count = 0
    rx_count = 0
    seq = 0
    pending: dict[int, int] = {}

    print(f"Test Pattern latency on {transport.label} — {rate_hz} Hz for {duration_sec}s")
    print()

    t_start = time.monotonic()
    next_send = t_start
    last_report = t_start

    try:
        while True:
            now = time.monotonic()
            if now - t_start >= duration_sec:
                break

            if now >= next_send:
                ts_us = tp_timestamp_us()
                extra = struct.pack(">I", ts_us)
                transport.send_test_message(TP_TAG_LATENCY_PROBE, 0x00, seq, extra)
                pending[seq] = ts_us
                tx_count += 1
                seq = (seq + 1) & 0xFFFF
                next_send += interval

            recv_timeout = max(0, min(next_send - time.monotonic(), 0.001))
            parsed = transport.recv_test_message(timeout=recv_timeout)
            if parsed and parsed["tag"] == TP_TAG_LATENCY_REPLY:
                resp_seq = parsed["seq"]
                rx_count += 1
                if resp_seq in pending:
                    sent_ts = pending.pop(resp_seq)
                    rtt = (tp_timestamp_us() - sent_ts) & 0xFFFFFFFF
                    latency_tracker.record(rtt)

            if now - last_report >= 5.0:
                elapsed = now - t_start
                lat = latency_tracker.summary()
                mean_str = f"  mean RTT: {lat['mean']} us" if lat else ""
                print(f"  [{elapsed:.0f}s] TX: {tx_count}  RX: {rx_count}{mean_str}")
                last_report = now

    except TransportError as e:
        print(f"\n  *** DISCONNECTED: {e} ***")
        if transport.can_reconnect and transport.wait_for_reconnect():
            print("  Reconnected — but latency test is complete for this run.")
    except KeyboardInterrupt:
        print("\nInterrupted.")

    # Drain trailing replies (skip if disconnected)
    try:
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            parsed = transport.recv_test_message(timeout=0.1)
            if parsed and parsed["tag"] == TP_TAG_LATENCY_REPLY:
                resp_seq = parsed["seq"]
                rx_count += 1
                if resp_seq in pending:
                    rtt = (tp_timestamp_us() - pending.pop(resp_seq)) & 0xFFFFFFFF
                    latency_tracker.record(rtt)
            elif parsed is None:
                break
    except TransportError:
        pass

    transport.close()

    elapsed = time.monotonic() - t_start
    lost = tx_count - rx_count
    lat = latency_tracker.summary()

    print()
    print("=" * 60)
    print("  Latency Results")
    print("=" * 60)
    print(f"  Transport    : {transport.label}")
    print(f"  Duration     : {elapsed:.1f}s")
    print(f"  Probes sent  : {tx_count}")
    print(f"  Replies recv : {rx_count}")
    print(f"  Lost         : {lost}")
    if lat:
        print(f"  RTT min      : {lat['min']} us")
        print(f"  RTT max      : {lat['max']} us")
        print(f"  RTT mean     : {lat['mean']} us")
        print(f"  RTT p50      : {lat['p50']} us")
        print(f"  RTT p95      : {lat['p95']} us")
        print(f"  RTT p99      : {lat['p99']} us")
    print("=" * 60)

    if json_report:
        report = {
            "test_mode": "latency",
            "transport": transport.label,
            "duration_sec": round(elapsed, 1),
            "rate_hz": rate_hz,
            "tx_count": tx_count,
            "rx_count": rx_count,
            "lost": lost,
            "latency_us": lat,
            "errors": [],
        }
        with open(json_report, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nReport written to {json_report}")


def main():
    parser = argparse.ArgumentParser(
        description="CAN / CAN FD / Serial transport test tool with Test Pattern protocol",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
CAN traffic generation:
  sudo %(prog)s --setup                            Setup vcan0 (classic CAN)
  sudo %(prog)s --setup --canfd                    Setup vcan0 with CAN FD MTU
  %(prog)s --send                                  Send classic CAN test frames
  %(prog)s --send --canfd                          Send CAN FD test frames
  %(prog)s --monitor                               Watch frames (like candump)
  %(prog)s --info                                  Show live interface config
  sudo %(prog)s -i vcan1 --setup --send --monitor  Full stack on vcan1

test pattern — CAN:
  %(prog)s --echo-responder -i can0                Respond to test frames
  %(prog)s --roundtrip -i can0 --rate 100          Ping-pong at 100 Hz
  %(prog)s --throughput -i can0 --duration 10      Flood for 10 seconds
  %(prog)s --latency -i can0 --rate 1              Latency probes at 1 Hz

test pattern — serial:
  %(prog)s --serial --echo-responder --port /dev/ttyUSB0
  %(prog)s --serial --roundtrip --port /dev/ttyUSB0 --baud 115200
  %(prog)s --serial --throughput --port /dev/ttyUSB0 --duration 10
  %(prog)s --serial --latency --port /dev/ttyUSB0 --rate 1

test pattern — GVRET TCP (client, connects to device):
  %(prog)s --gvret --echo-responder --host 192.168.1.10 --gvret-port 9999
  %(prog)s --gvret --roundtrip --host 192.168.1.10 --rate 100
  %(prog)s --gvret --throughput --host 192.168.1.10 --duration 10

test pattern — GVRET TCP (server, WireTAP connects to us):
  %(prog)s --gvret-listen --echo-responder --host 0.0.0.0 --gvret-port 9999
  %(prog)s --gvret-listen --roundtrip --host 0.0.0.0 --gvret-port 9999 --rate 100
""",
    )

    # Interface and mode
    parser.add_argument("-i", "--interface", default=DEFAULT_INTERFACE,
                        help=f"CAN interface name (default: {DEFAULT_INTERFACE})")
    parser.add_argument("--canfd", action="store_true",
                        help="Use CAN FD (64-byte frames with BRS); default is classic CAN")

    # Serial transport
    ser = parser.add_argument_group("serial transport")
    ser.add_argument("--serial", action="store_true",
                     help="Use serial transport instead of CAN (requires pyserial)")
    ser.add_argument("--port", type=str, default=DEFAULT_SERIAL_PORT,
                     help=f"Serial port (default: {DEFAULT_SERIAL_PORT})")
    ser.add_argument("--baud", type=int, default=DEFAULT_SERIAL_BAUD,
                     help=f"Serial baud rate (default: {DEFAULT_SERIAL_BAUD})")
    ser.add_argument("--framing", type=str, default="cobs", choices=["cobs", "slip"],
                     help="Serial framing protocol (default: cobs)")

    # GVRET TCP transport
    gvr = parser.add_argument_group("GVRET TCP transport")
    gvr.add_argument("--gvret", action="store_true",
                     help="Use GVRET binary protocol over TCP (client mode)")
    gvr.add_argument("--gvret-listen", action="store_true",
                     help="Run as a GVRET TCP server (WireTAP connects to us)")
    gvr.add_argument("--host", type=str, default="192.168.1.10",
                     help="GVRET host to connect to, or bind address for --gvret-listen"
                          " (default: 192.168.1.10, use 0.0.0.0 for listen on all)")
    gvr.add_argument("--gvret-port", type=int, default=9999,
                     help="GVRET TCP port (default: 9999)")
    gvr.add_argument("--bus", type=int, default=0,
                     help="GVRET bus number for transmit (default: 0)")
    gvr.add_argument("--num-buses", type=int, default=1,
                     help="Number of buses to advertise in server mode (default: 1)")

    # CAN traffic generation actions
    gen = parser.add_argument_group("CAN traffic generation")
    gen.add_argument("--setup", action="store_true",
                     help="Create/configure the CAN interface")
    gen.add_argument("--send", action="store_true",
                     help="Send test frames in a loop")
    gen.add_argument("--monitor", action="store_true",
                     help="Monitor frames on the interface (like candump)")
    gen.add_argument("--info", action="store_true",
                     help="Show live configuration of the interface")

    # Test Pattern actions
    tp = parser.add_argument_group("test pattern protocol")
    tp.add_argument("--echo-responder", action="store_true",
                    help="Run as responder: reply to ping/latency test frames")
    tp.add_argument("--roundtrip", action="store_true",
                    help="Run as initiator: send pings, track responses and drops")
    tp.add_argument("--throughput", action="store_true",
                    help="Run as initiator: flood throughput frames")
    tp.add_argument("--latency", action="store_true",
                    help="Run as initiator: send latency probes, measure RTT")
    tp.add_argument("--rate", type=float, default=10.0,
                    help="Test frame rate in Hz (default: 10, used by --roundtrip and --latency)")
    tp.add_argument("--duration", type=float, default=10.0,
                    help="Test duration in seconds (default: 10)")
    tp.add_argument("--json-report", type=str, default=None, metavar="PATH",
                    help="Write JSON results to file on completion")

    # Bus speeds (used for physical interfaces during --setup)
    parser.add_argument("--bitrate", type=int, default=DEFAULT_BITRATE,
                        help=f"CAN arbitration bitrate in bps (default: {DEFAULT_BITRATE})")
    parser.add_argument("--dbitrate", type=int, default=DEFAULT_DBITRATE,
                        help=f"CAN FD data bitrate in bps (default: {DEFAULT_DBITRATE})")

    # Timing (CAN traffic generation)
    parser.add_argument("--delay", type=int, default=DEFAULT_DELAY,
                        help=f"Delay between frames in ms (default: {DEFAULT_DELAY})")
    parser.add_argument("--cycle-pause", type=int, default=DEFAULT_CYCLE_PAUSE,
                        help=f"Pause between cycles in ms (default: {DEFAULT_CYCLE_PAUSE})")
    parser.add_argument("--cycles", type=int, default=0,
                        help="Number of cycles to send (default: 0 = infinite)")

    args = parser.parse_args()

    has_tp = args.echo_responder or args.roundtrip or args.throughput or args.latency
    has_can = args.setup or args.send or args.monitor or args.info
    if not (has_tp or has_can):
        parser.print_help()
        sys.exit(1)

    # --- Test Pattern protocol modes ---
    if has_tp:
        # Create the appropriate transport
        if args.gvret or args.gvret_listen:
            transport = GVRETTransport(args.host, args.gvret_port, args.bus,
                                       listen=args.gvret_listen,
                                       num_buses=args.num_buses)
        elif args.serial:
            transport = SerialTransport(args.port, args.baud, args.framing)
        else:
            transport = CANTransport(args.interface, args.canfd)

        if args.echo_responder:
            echo_responder(transport)
            return

        if args.roundtrip:
            roundtrip_test(transport, args.rate, args.duration, args.json_report)
            return

        if args.throughput:
            throughput_test(transport, args.duration, args.json_report)
            return

        if args.latency:
            latency_test(transport, args.rate, args.duration, args.json_report)
            return

    # --- Traffic generation modes (original) ---
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
