// A Modbus archive row is one whole RTU message, id = unit << 8 | function. It
// reaches the frontend as `modbus_rtu` — never `modbus`, which is a register
// poll and would decode the unit/function word as a register number — and is
// shown as `unit/function`, not as a CAN identifier.
//
// The Rust half of the wire contract is `batch_modbus_rtu_message_keeps_its_unit_function_word`
// in ws/protocol.rs.

import { describe, it, expect } from "vitest";
import { decodeFrameBatch, FrameType } from "../services/wsProtocol";
import { formatModbusRtuId, formatProtocolFrameId, splitModbusRtuId } from "../utils/frameIds";

/** Mirrors `encode_frame_batch` in src-tauri/src/ws/protocol.rs for one prefixed frame. */
function envelope(frameType: number, bus: number, prefix: number, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(12 + 4 + payload.length);
  const view = new DataView(buf);
  view.setBigUint64(0, 1_789_162_108_768_476n, true);
  view.setUint8(8, bus);
  view.setUint16(9, frameType, true);
  view.setUint8(11, 4 + payload.length);
  view.setUint32(12, prefix, true);
  new Uint8Array(buf).set(payload, 16);
  return buf;
}

describe("Modbus RTU archive rows", () => {
  it("decode as modbus_rtu with the unit/function word as frame_id", () => {
    const raw = [0x02, 0x65, 0x03, 0x00, 0x2e, 0x3a, 0xca];
    const [frame] = decodeFrameBatch(envelope(FrameType.ModbusRtu, 2, 0x0265, raw), 0);
    expect(frame.protocol).toBe("modbus_rtu");
    expect(frame.frame_id).toBe(0x0265);
    expect(frame.bus).toBe(2);
    expect(frame.dlc).toBe(raw.length);
    expect(frame.bytes).toEqual(raw);
  });

  it("keep register polls as modbus", () => {
    const [frame] = decodeFrameBatch(envelope(FrameType.Modbus, 0, 5013, [0x00, 0x2a]), 0);
    expect(frame.protocol).toBe("modbus");
    expect(frame.frame_id).toBe(5013);
  });

  it("read as unit/function, not as a CAN id", () => {
    expect(splitModbusRtuId(0x0265)).toEqual({ unit: 2, func: 0x65 });
    expect(formatModbusRtuId(0x0265)).toBe("2/0x65");
    expect(formatModbusRtuId(0x0265, "decimal")).toBe("2/101");
    expect(formatModbusRtuId(0x0060)).toBe("0/0x60");
    expect(formatProtocolFrameId("modbus_rtu", 0x0120)).toBe("1/0x20");
    expect(formatProtocolFrameId("can", 0x120)).toBe("0x120");
    expect(formatProtocolFrameId(undefined, 0x120, "decimal")).toBe("288");
  });
});
