// utils/modbusPollBuilder.ts
//
// Builds Modbus TCP poll groups from parsed catalog frames.
// Used by the decoder session handler to pass poll configuration to the
// Rust ModbusTcpReader when starting a Modbus TCP session.

import type { ResolvedFrame, ModbusProtocolConfig } from './catalogParser';

/** A poll group sent to the Rust backend as JSON */
export interface ModbusPollGroup {
  register_type: 'holding' | 'input' | 'coil' | 'discrete';
  /** Protocol-level start address (0-based, 0-65535) */
  start_register: number;
  /** Number of registers (or coils) to read */
  count: number;
  /** Poll interval in milliseconds */
  interval_ms: number;
  /** frame_id to emit (= catalog register_number) */
  frame_id: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Build poll groups from the Modbus frames in a parsed catalog.
 *
 * Each Modbus frame entry becomes one poll group. The register_number
 * from the catalog is used as both the protocol address and the frame_id.
 *
 * If register_base=1 (traditional Modbus addressing), the register_number
 * includes the type prefix (e.g. 40001 for first holding register).
 * The protocol-level address is derived by subtracting the type offset.
 *
 * If register_base=0 (IEC), register_number is the direct protocol address.
 */
export function buildPollsFromCatalog(
  frames: Map<number, ResolvedFrame>,
  modbusConfig: ModbusProtocolConfig | null,
): ModbusPollGroup[] {
  const registerBase = modbusConfig?.register_base ?? 0;
  const defaultInterval = modbusConfig?.default_interval ?? DEFAULT_POLL_INTERVAL_MS;
  const polls: ModbusPollGroup[] = [];

  for (const [_id, frame] of frames) {
    if (frame.protocol !== 'modbus') continue;

    const registerType = frame.modbusRegisterType ?? 'holding';
    const registerCount = frame.modbusRegisterCount ?? 1;
    const intervalMs = frame.interval ?? defaultInterval;

    // Convert catalog register_number to protocol-level address
    let startRegister: number;
    if (registerBase === 1) {
      // Traditional addressing: subtract type offset
      // Coils: 1-9999 → protocol 0-9998
      // Discrete: 10001-19999 → protocol 0-9998
      // Input: 30001-39999 → protocol 0-9998
      // Holding: 40001-49999 → protocol 0-9998
      startRegister = traditionalToProtocol(frame.frameId, registerType);
    } else {
      // IEC addressing: direct protocol address
      startRegister = frame.frameId;
    }

    polls.push({
      register_type: registerType,
      start_register: startRegister,
      count: registerCount,
      interval_ms: intervalMs,
      frame_id: frame.frameId,
    });
  }

  return polls;
}

/**
 * Convert traditional Modbus register number (1-based with type prefix)
 * to protocol-level address (0-based).
 */
function traditionalToProtocol(
  registerNumber: number,
  registerType: 'holding' | 'input' | 'coil' | 'discrete',
): number {
  switch (registerType) {
    case 'coil':
      // 1-9999 → 0-9998
      return Math.max(0, registerNumber - 1);
    case 'discrete':
      // 10001-19999 → 0-9998
      return Math.max(0, registerNumber - 10001);
    case 'input':
      // 30001-39999 → 0-9998
      return Math.max(0, registerNumber - 30001);
    case 'holding':
      // 40001-49999 → 0-9998
      return Math.max(0, registerNumber - 40001);
  }
}
