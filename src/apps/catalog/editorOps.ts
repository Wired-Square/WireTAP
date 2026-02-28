// ui/src/apps/catalog/editorOps.ts

import type { MetaFields, ProtocolType, BaseFrameFields, ProtocolConfig, ModbusConfig, SerialConfig, CanProtocolConfig, ModbusProtocolConfig, SerialProtocolConfig, SerialEncoding, ChecksumAlgorithm, ChecksumDefinition } from "./types";
import { tomlParse, tomlStringify } from "./toml";
import { protocolRegistry } from "./protocols";


function normalizeKeySegment(seg: string): string {
  // Tree paths may include quoted TOML keys (e.g. "0x700", "2").
  // Parsed objects use the raw key without quotes.
  if (seg.startsWith('"') && seg.endsWith('"') && seg.length >= 2) {
    return seg.slice(1, -1);
  }
  return seg;
}

function isNumericSegment(seg: string): boolean {
  return /^-?\d+$/.test(seg);
}

/**
 * Traverse a mixed object/array structure, creating intermediate containers as needed.
 * Special-cases the "signals" key to always be an array.
 */
function getOrCreateContainerAtPath(root: any, path: string[]): any {
  let cur: any = root;

  for (const rawSeg of path) {
    const seg = normalizeKeySegment(rawSeg);

    // If we're currently inside an array, numeric segments index into it.
    if (Array.isArray(cur)) {
      if (!isNumericSegment(seg)) {
        throw new Error(`Expected numeric path segment for array, got: ${seg}`);
      }
      const idx = Number(seg);
      if (!cur[idx] || typeof cur[idx] !== "object" || Array.isArray(cur[idx])) {
        cur[idx] = {};
      }
      cur = cur[idx];
      continue;
    }

    // Otherwise we're in an object.
    if (seg === "signals") {
      cur = ensureArray(cur, "signals");
      continue;
    }

    cur = ensureObject(cur, seg);
  }

  return cur;
}

function normalizeSignalTarget(targetPath: string[], index: number | null): { ownerPath: string[]; index: number | null } {
  // Allow callers to pass a full signal-node path like [..., "signals", "3"].
  if (
    index === null &&
    targetPath.length >= 2 &&
    targetPath[targetPath.length - 2] === "signals" &&
    isNumericSegment(targetPath[targetPath.length - 1])
  ) {
    const idx = Number(targetPath[targetPath.length - 1]);
    const ownerPath = targetPath.slice(0, -2);
    return { ownerPath, index: idx };
  }

  return { ownerPath: targetPath, index };
}

function ensureObject(obj: any, key: string): any {
  const k = normalizeKeySegment(key);
  if (!obj[k] || typeof obj[k] !== "object" || Array.isArray(obj[k])) {
    obj[k] = {};
  }
  return obj[k];
}

function getContainerAtPath(root: any, path: string[]): any | undefined {
  let cur: any = root;

  for (const rawSeg of path) {
    if (cur === undefined || cur === null) return undefined;
    const seg = normalizeKeySegment(rawSeg);

    if (Array.isArray(cur)) {
      if (!isNumericSegment(seg)) return undefined;
      cur = cur[Number(seg)];
      continue;
    }

    if (typeof cur !== "object") return undefined;
    cur = (cur as any)[seg];
  }

  return cur;
}

function getOrCreatePath(root: any, path: string[]): any {
  return getOrCreateContainerAtPath(root, path);
}

function ensureArray(obj: any, key: string): any[] {
  const k = normalizeKeySegment(key);
  if (!obj[k] || !Array.isArray(obj[k])) obj[k] = [];
  return obj[k];
}

function numericKeyCompare(a: string, b: string): number {
  const normalize = (v: string) => {
    if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v, 16);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return null;
  };

  const aNum = normalize(a);
  const bNum = normalize(b);
  if (aNum !== null && bNum !== null) return aNum - bNum;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function sortObjectKeysNumeric(obj: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  Object.keys(obj)
    .sort(numericKeyCompare)
    .forEach((k) => {
      sorted[k] = obj[k];
    });
  return sorted;
}

export function createMinimalCatalogToml(meta: MetaFields): string {
  const cat: any = {
    meta: {
      name: meta.name,
      version: meta.version,
    },
  };

  // Protocol configs are added via upsertCanConfigToml, upsertSerialConfigToml, upsertModbusConfigToml
  // They are stored at [meta.can], [meta.serial], [meta.modbus]

  return tomlStringify(cat);
}

export function updateMetaToml(toml: string, meta: MetaFields): string {
  const parsed = tomlParse(toml) as any;

  // Preserve existing protocol configs when updating meta fields
  const existingCan = parsed.meta?.can;
  const existingSerial = parsed.meta?.serial;
  const existingModbus = parsed.meta?.modbus;

  parsed.meta = {
    name: meta.name,
    version: meta.version,
    // Restore protocol configs
    ...(existingCan && { can: existingCan }),
    ...(existingSerial && { serial: existingSerial }),
    ...(existingModbus && { modbus: existingModbus }),
  };
  return tomlStringify(parsed);
}

// ============================================================================
// CAN Protocol Config Operations
// ============================================================================

/**
 * Get the CAN protocol config from [meta.can].
 */
export function getCanConfig(toml: string): CanProtocolConfig | null {
  const parsed = tomlParse(toml) as any;
  const configSection = parsed?.meta?.can;
  if (!configSection || typeof configSection !== "object") return null;

  // Support both new key (default_byte_order) and old key (default_endianness) for backwards compatibility
  const byteOrderValue = configSection.default_byte_order ?? configSection.default_endianness;
  const defaultEndianness = byteOrderValue === "big" ? "big" as const
    : byteOrderValue === "little" ? "little" as const
    : null;

  // default_byte_order is required
  if (!defaultEndianness) return null;

  const config: CanProtocolConfig = { default_endianness: defaultEndianness };

  // default_interval is optional
  if (typeof configSection.default_interval === "number") {
    config.default_interval = configSection.default_interval;
  }

  // frame_id_mask is optional (e.g., 0x1FFFFF00 for J1939)
  if (typeof configSection.frame_id_mask === "number") {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  // default_extended is optional (default: undefined = auto-detect from ID)
  if (typeof configSection.default_extended === "boolean") {
    config.default_extended = configSection.default_extended;
  }

  // default_fd is optional (default: undefined = classic CAN)
  if (typeof configSection.default_fd === "boolean") {
    config.default_fd = configSection.default_fd;
  }

  // Header fields are parsed elsewhere (in toml.ts), not here

  return config;
}

/**
 * Upsert the CAN protocol config in [meta.can].
 * This stores default_byte_order and optional default_interval.
 * Mask values are stored as hex literals in the TOML output.
 */
export function upsertCanConfigToml(toml: string, config: CanProtocolConfig): string {
  const parsed = tomlParse(toml) as any;
  const meta = ensureObject(parsed, "meta");

  // Build config object - use default_byte_order as the TOML key
  const configObj: any = {
    default_byte_order: config.default_endianness,
  };

  if (config.default_interval !== undefined) {
    configObj.default_interval = config.default_interval;
  }

  // Store default_extended if explicitly set
  if (config.default_extended !== undefined) {
    configObj.default_extended = config.default_extended;
  }

  // Store default_fd if explicitly set
  if (config.default_fd !== undefined) {
    configObj.default_fd = config.default_fd;
  }

  // Store frame_id_mask as hex marker string
  if (config.frame_id_mask !== undefined) {
    configObj.frame_id_mask = `__HEX__0x${config.frame_id_mask.toString(16).toUpperCase()}`;
  }

  // Serialize header fields if present (with masks as hex)
  if (config.fields && Object.keys(config.fields).length > 0) {
    const fieldsObj: any = {};
    for (const [name, field] of Object.entries(config.fields)) {
      const hexMask = `__HEX__0x${field.mask.toString(16).toUpperCase()}`;
      const fieldObj: any = { mask: hexMask };
      if (field.shift !== undefined && field.shift !== 0) {
        fieldObj.shift = field.shift;
      }
      if (field.format && field.format !== "hex") {
        fieldObj.format = field.format;
      }
      fieldsObj[name] = fieldObj;
    }
    configObj.fields = fieldsObj;
  }

  meta.can = configObj;

  return tomlStringify(parsed);
}

/**
 * Delete the CAN protocol config section from [meta.can].
 */
export function deleteCanConfigToml(toml: string): string {
  const parsed = tomlParse(toml) as any;
  if (parsed?.meta?.can) {
    delete parsed.meta.can;
  }
  return tomlStringify(parsed);
}

// ============================================================================
// Serial Protocol Config Operations
// ============================================================================

/**
 * Get the serial protocol config from [meta.serial].
 */
export function getSerialConfig(toml: string): SerialProtocolConfig | null {
  const parsed = tomlParse(toml) as any;
  const configSection = parsed?.meta?.serial;
  if (!configSection || typeof configSection !== "object") return null;

  const validEncodings: SerialEncoding[] = ["slip", "cobs", "raw", "length_prefixed"];
  if (!validEncodings.includes(configSection.encoding)) return null;

  const config: SerialProtocolConfig = { encoding: configSection.encoding };

  // frame_id_mask is optional (e.g., 0xFF00 to match on TYPE only, ignore COMMAND)
  if (typeof configSection.frame_id_mask === "number") {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  return config;
}

/**
 * Upsert the serial protocol config in [meta.serial].
 * This is separate from per-frame settings - all serial frames share this config.
 */
export function upsertSerialConfigToml(toml: string, config: SerialProtocolConfig): string {
  const parsed = tomlParse(toml) as any;
  const meta = ensureObject(parsed, "meta");

  // Build config object
  const configObj: any = {
    encoding: config.encoding,
  };

  // byte_order is optional (defaults to big endian)
  if (config.byte_order) {
    configObj.byte_order = config.byte_order;
  }

  // header_length is required when fields are defined
  if (config.header_length !== undefined && config.header_length > 0) {
    configObj.header_length = config.header_length;
  }

  // max_frame_length is optional (default: 64 in backend)
  if (config.max_frame_length !== undefined && config.max_frame_length > 0) {
    configObj.max_frame_length = config.max_frame_length;
  }

  // Serialize header fields if present (new mask-based format)
  // Note: mask values are stored as hex strings with a marker prefix
  // that gets converted to hex literals in tomlStringify
  if (config.fields && Object.keys(config.fields).length > 0) {
    const fieldsObj: any = {};
    for (const [name, field] of Object.entries(config.fields)) {
      // Store mask as hex marker string (e.g., "__HEX__0xFF00")
      // This will be converted to actual hex literal in tomlStringify
      const hexMask = `__HEX__0x${field.mask.toString(16).toUpperCase()}`;
      const fieldObj: any = { mask: hexMask };
      // Only include non-default values
      if (field.endianness && field.endianness !== "big") {
        fieldObj.endianness = field.endianness;
      }
      if (field.format && field.format !== "hex") {
        fieldObj.format = field.format;
      }
      fieldsObj[name] = fieldObj;
    }
    configObj.fields = fieldsObj;
  }

  // Serialize checksum config if present
  if (config.checksum) {
    const checksumObj: any = {
      algorithm: config.checksum.algorithm,
      start_byte: config.checksum.start_byte,
      byte_length: config.checksum.byte_length,
      calc_start_byte: config.checksum.calc_start_byte,
      calc_end_byte: config.checksum.calc_end_byte,
    };
    if (config.checksum.big_endian) {
      checksumObj.big_endian = true;
    }
    configObj.checksum = checksumObj;
  }

  // Note: frame_id_mask is deprecated - use 'id' header field instead
  // We don't write frame_id_mask anymore, but legacy files may still have it

  meta.serial = configObj;

  return tomlStringify(parsed);
}

/**
 * Delete the serial protocol config section from [meta.serial].
 */
export function deleteSerialConfigToml(toml: string): string {
  const parsed = tomlParse(toml) as any;
  if (parsed?.meta?.serial) {
    delete parsed.meta.serial;
  }
  return tomlStringify(parsed);
}

// ============================================================================
// Modbus Protocol Config Operations
// ============================================================================

/**
 * Get the modbus protocol config from [meta.modbus].
 */
export function getModbusConfig(toml: string): ModbusProtocolConfig | null {
  const parsed = tomlParse(toml) as any;
  const configSection = parsed?.meta?.modbus;
  if (!configSection || typeof configSection !== "object") return null;

  const deviceAddress = typeof configSection.device_address === "number"
    ? configSection.device_address
    : undefined;
  const registerBase = configSection.register_base === 0 || configSection.register_base === 1
    ? (configSection.register_base as 0 | 1)
    : undefined;

  if (deviceAddress === undefined || registerBase === undefined) return null;

  return { device_address: deviceAddress, register_base: registerBase };
}

/**
 * Upsert the modbus protocol config in [meta.modbus].
 * This is separate from per-frame settings - all modbus frames share this config.
 */
export function upsertModbusConfigToml(toml: string, config: ModbusProtocolConfig): string {
  const parsed = tomlParse(toml) as any;
  const meta = ensureObject(parsed, "meta");

  // Ensure config section exists and set values
  const modbusObj: Record<string, any> = {
    device_address: config.device_address,
    register_base: config.register_base,
  };

  if (config.default_interval !== undefined) {
    modbusObj.default_interval = config.default_interval;
  }

  if (config.default_byte_order !== undefined) {
    modbusObj.default_byte_order = config.default_byte_order;
  }

  if (config.default_word_order !== undefined) {
    modbusObj.default_word_order = config.default_word_order;
  }

  meta.modbus = modbusObj;

  return tomlStringify(parsed);
}

/**
 * Delete the modbus protocol config section from [meta.modbus].
 */
export function deleteModbusConfigToml(toml: string): string {
  const parsed = tomlParse(toml) as any;
  if (parsed?.meta?.modbus) {
    delete parsed.meta.modbus;
  }
  return tomlStringify(parsed);
}

export interface UpsertCanFrameParams {
  /** If editing and the id changed, provide the old id */
  oldId?: string | null;
  id: string;
  length: number;
  transmitter?: string;
  interval?: number;
  isLengthInherited?: boolean;
  isTransmitterInherited?: boolean;
  isIntervalInherited?: boolean;
  notes?: string | string[];
}

export function upsertCanFrameToml(toml: string, p: UpsertCanFrameParams): string {
  const parsed = tomlParse(toml) as any;
  const frame = ensureObject(parsed, "frame");
  const can = ensureObject(frame, "can");

  const newId = normalizeKeySegment(p.id);
  const oldId = p.oldId ? normalizeKeySegment(p.oldId) : null;

  if (oldId && oldId !== newId && can[oldId]) {
    can[newId] = can[oldId];
    delete can[oldId];
  }

  if (!can[newId] || typeof can[newId] !== "object") can[newId] = {};

  // length
  if (!p.isLengthInherited) {
    can[newId].length = p.length;
  } else {
    delete can[newId].length;
  }

  // notes (can be string or array of strings)
  if (p.notes) {
    // Normalize: if array with single element, store as string
    if (Array.isArray(p.notes)) {
      if (p.notes.length === 0) {
        delete can[newId].notes;
      } else if (p.notes.length === 1) {
        can[newId].notes = p.notes[0];
      } else {
        can[newId].notes = p.notes;
      }
    } else {
      can[newId].notes = p.notes;
    }
  } else {
    delete can[newId].notes;
  }

  // transmitter
  if (p.transmitter && !p.isTransmitterInherited) {
    can[newId].transmitter = p.transmitter;
  } else {
    delete can[newId].transmitter;
  }

  // interval (stored as tx.interval_ms)
  if (p.interval !== undefined && !p.isIntervalInherited) {
    const tx = ensureObject(can[newId], "tx");
    tx.interval_ms = p.interval;
  } else {
    if (can[newId].tx) {
      delete can[newId].tx.interval_ms;
      if (Object.keys(can[newId].tx).length === 0) delete can[newId].tx;
    }
  }

  frame.can = sortObjectKeysNumeric(frame.can);

  return tomlStringify(parsed);
}

export function deleteCanFrameToml(toml: string, id: string): string {
  const parsed = tomlParse(toml) as any;
  const k = normalizeKeySegment(id);
  if (parsed?.frame?.can && parsed.frame.can[k]) {
    delete parsed.frame.can[k];
    parsed.frame.can = sortObjectKeysNumeric(parsed.frame.can);
  }
  return tomlStringify(parsed);
}

// ============================================================================
// Generic Frame Operations (Protocol-Agnostic)
// ============================================================================

export interface UpsertFrameParams {
  protocol: ProtocolType;
  base: BaseFrameFields;
  config: ProtocolConfig;
  /** Original key if editing (to handle renames) */
  originalKey?: string;
  /** Which fields are inherited (omit from TOML) */
  omitInherited?: {
    length?: boolean;
    transmitter?: boolean;
    interval?: boolean;
    deviceAddress?: boolean;
    registerBase?: boolean;
  };
  /** Initial signals to add for new frames (only applied if frame doesn't exist) */
  initialSignals?: Array<{
    name: string;
    start_bit: number;
    bit_length: number;
    signed?: boolean;
    endianness?: "little" | "big";
  }>;
}

/**
 * Generic function to upsert any frame type using the protocol registry.
 * Protocol handlers serialize their config to TOML-compatible objects.
 */
export function upsertFrameToml(toml: string, params: UpsertFrameParams): string {
  const { protocol, base, config, originalKey, omitInherited, initialSignals } = params;

  const handler = protocolRegistry.get(protocol);
  if (!handler) {
    throw new Error(`Unknown protocol: ${protocol}`);
  }

  const parsed = tomlParse(toml) as any;
  const frame = ensureObject(parsed, "frame");
  const protocolSection = ensureObject(frame, protocol);

  // Get the key for this frame from the handler
  const newKey = normalizeKeySegment(handler.getFrameKey(config));
  const oldKey = originalKey ? normalizeKeySegment(originalKey) : null;

  // Check if this is a new frame (no existing data)
  const isNewFrame = !protocolSection[newKey] && !oldKey;

  // Handle rename: copy data from old key to new key, then delete old
  if (oldKey && oldKey !== newKey && protocolSection[oldKey]) {
    protocolSection[newKey] = protocolSection[oldKey];
    delete protocolSection[oldKey];
  }

  // Use the handler to serialize the frame
  const serialized = handler.serializeFrame(newKey, base, config, omitInherited);

  // Merge with existing data (preserves signals, mux, etc.)
  if (!protocolSection[newKey] || typeof protocolSection[newKey] !== "object") {
    protocolSection[newKey] = {};
  }

  // Update frame properties (but keep signals and mux intact)
  const existing = protocolSection[newKey];
  const existingSignals = existing.signals;
  const existingMux = existing.mux;

  // Apply serialized data
  Object.assign(protocolSection[newKey], serialized);

  // Restore signals and mux if they weren't in the serialized output
  if (existingSignals && !serialized.signals) {
    protocolSection[newKey].signals = existingSignals;
  }
  if (existingMux && !serialized.mux) {
    protocolSection[newKey].mux = existingMux;
  }

  // Add initial signals for new frames (if provided and no existing signals)
  if (isNewFrame && initialSignals && initialSignals.length > 0 && !protocolSection[newKey].signals) {
    protocolSection[newKey].signals = initialSignals;
  }

  // Sort keys numerically for CAN frames
  if (protocol === "can") {
    frame.can = sortObjectKeysNumeric(frame.can);
  }

  return tomlStringify(parsed);
}

/**
 * Delete a frame by protocol and key.
 */
export function deleteFrameToml(toml: string, protocol: ProtocolType, key: string): string {
  const parsed = tomlParse(toml) as any;
  const k = normalizeKeySegment(key);

  if (parsed?.frame?.[protocol] && parsed.frame[protocol][k]) {
    delete parsed.frame[protocol][k];

    // Sort keys for CAN frames
    if (protocol === "can") {
      parsed.frame.can = sortObjectKeysNumeric(parsed.frame.can);
    }
  }

  return tomlStringify(parsed);
}

/**
 * Get all existing frame keys for a protocol (for duplicate detection).
 */
export function getFrameKeys(toml: string, protocol: ProtocolType): string[] {
  const parsed = tomlParse(toml) as any;
  const protocolSection = parsed?.frame?.[protocol];
  if (!protocolSection || typeof protocolSection !== "object") {
    return [];
  }
  return Object.keys(protocolSection);
}

// ============================================================================
// Protocol-Specific Wrappers (Backward Compatibility)
// ============================================================================

/**
 * Upsert a Modbus frame.
 */
export interface UpsertModbusFrameParams {
  /** If editing and the key changed, provide the old key */
  oldKey?: string | null;
  /** Friendly name / TOML key */
  key: string;
  registerNumber: number;
  deviceAddress: number;
  registerType?: "holding" | "input" | "coil" | "discrete";
  length?: number;
  transmitter?: string;
  interval?: number;
  notes?: string | string[];
  isDeviceAddressInherited?: boolean;
  isIntervalInherited?: boolean;
}

export function upsertModbusFrameToml(toml: string, p: UpsertModbusFrameParams): string {
  const base: BaseFrameFields = {
    length: p.length ?? 1,
    transmitter: p.transmitter,
    interval: p.interval,
    notes: p.notes,
  };

  const config: ModbusConfig = {
    protocol: "modbus",
    register_number: p.registerNumber,
    device_address: p.deviceAddress,
    register_type: p.registerType ?? "holding",
  };

  return upsertFrameToml(toml, {
    protocol: "modbus",
    base,
    config,
    originalKey: p.oldKey ?? undefined,
    omitInherited: {
      deviceAddress: p.isDeviceAddressInherited,
      interval: p.isIntervalInherited,
    },
  });
}

/**
 * Delete a Modbus frame.
 */
export function deleteModbusFrameToml(toml: string, key: string): string {
  return deleteFrameToml(toml, "modbus", key);
}

/**
 * Upsert a Serial frame.
 * NOTE: Encoding is NOT set per-frame - it's in [meta.serial]
 */
export interface UpsertSerialFrameParams {
  /** If editing and the key changed, provide the old key */
  oldKey?: string | null;
  /** Frame identifier / TOML key */
  frameId: string;
  length?: number;
  delimiter?: number[];
  transmitter?: string;
  interval?: number;
  notes?: string | string[];
  isIntervalInherited?: boolean;
}

export function upsertSerialFrameToml(toml: string, p: UpsertSerialFrameParams): string {
  const base: BaseFrameFields = {
    length: p.length ?? 0,
    transmitter: p.transmitter,
    interval: p.interval,
    notes: p.notes,
  };

  const config: SerialConfig = {
    protocol: "serial",
    frame_id: p.frameId,
    delimiter: p.delimiter,
    // NOTE: encoding is NOT here - it's in [meta.serial]
  };

  return upsertFrameToml(toml, {
    protocol: "serial",
    base,
    config,
    originalKey: p.oldKey ?? undefined,
    omitInherited: {
      interval: p.isIntervalInherited,
    },
  });
}

/**
 * Delete a Serial frame.
 */
export function deleteSerialFrameToml(toml: string, key: string): string {
  return deleteFrameToml(toml, "serial", key);
}

export interface SignalData {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: "little" | "big";
  min?: number;
  max?: number;
  format?: string;
  confidence?: string;
  enum?: Record<string, string>;
  notes?: string;
}

export function upsertSignalToml(toml: string, targetPath: string[], signal: SignalData, index: number | null): string {
  const parsed = tomlParse(toml) as any;
  const normalized = normalizeSignalTarget(targetPath, index);
  const target = getOrCreatePath(parsed, normalized.ownerPath);
  const signals = ensureArray(target, "signals");
  const signalIndex = normalized.index;

  // only include non-default fields (keeps TOML tidy)
  const data: any = {
    name: signal.name,
    start_bit: signal.start_bit,
    bit_length: signal.bit_length,
  };

  if (signal.factor !== undefined && signal.factor !== 1) data.factor = signal.factor;
  if (signal.offset !== undefined && signal.offset !== 0) data.offset = signal.offset;
  if (signal.unit) data.unit = signal.unit;
  if (signal.signed !== undefined) data.signed = signal.signed;
  if (signal.endianness) data.byte_order = signal.endianness;
  if (signal.min !== undefined) data.min = signal.min;
  if (signal.max !== undefined) data.max = signal.max;
  if (signal.format) data.format = signal.format;
  if (signal.confidence) data.confidence = signal.confidence;
  if (signal.enum) data.enum = signal.enum;
  if (signal.notes) data.notes = signal.notes;

  if (signalIndex !== null && signalIndex >= 0 && signalIndex < signals.length) {
    signals[signalIndex] = data;
  } else {
    signals.push(data);
  }

  signals.sort((a: any, b: any) => {
    const aStart = a.start_bit ?? 0;
    const bStart = b.start_bit ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aLen = a.bit_length ?? 0;
    const bLen = b.bit_length ?? 0;
    if (aLen !== bLen) return aLen - bLen;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  });

  return tomlStringify(parsed);
}

export function deleteSignalToml(toml: string, signalsParentPath: string[], index: number): string {
  const parsed = tomlParse(toml) as any;

  const normalized = normalizeSignalTarget(signalsParentPath, index);
  const target = getContainerAtPath(parsed, normalized.ownerPath);
  const idx = normalized.index;

  if (target && Array.isArray((target as any).signals) && idx !== null && idx >= 0 && idx < (target as any).signals.length) {
    (target as any).signals.splice(idx, 1);
  }

  return tomlStringify(parsed);
}

export interface MuxData {
  name: string;
  start_bit: number;
  bit_length: number;
  notes?: string;
}

/**
 * Upsert a mux object on the target node.
 * `muxOwnerPath` points to the frame or case object that owns the mux (NOT including "mux").
 */
export function upsertMuxToml(toml: string, muxOwnerPath: string[], mux: MuxData): string {
  const parsed = tomlParse(toml) as any;
  const owner = getOrCreatePath(parsed, muxOwnerPath);
  const muxObj = ensureObject(owner, "mux");
  muxObj.name = mux.name;
  muxObj.start_bit = mux.start_bit;
  muxObj.bit_length = mux.bit_length;
  if (mux.notes) {
    muxObj.notes = mux.notes;
  } else {
    delete muxObj.notes;
  }
  return tomlStringify(parsed);
}

/**
 * Delete mux at a path that includes the key "mux" as its last segment.
 */
export function deleteMuxToml(toml: string, muxPath: string[]): string {
  const parsed = tomlParse(toml) as any;
  if (muxPath.length === 0) return toml;
  const parentPath = muxPath.slice(0, -1);
  const key = normalizeKeySegment(muxPath[muxPath.length - 1]);
  const parent = getContainerAtPath(parsed, parentPath);
  if (parent && typeof parent === "object") {
    delete parent[key];
  }
  return tomlStringify(parsed);
}

/**
 * Add a case to a mux object.
 * `muxPath` points directly to the mux object (including "mux").
 */
export function addMuxCaseToml(toml: string, muxPath: string[], caseValue: string, notes?: string): { toml: string; didAdd: boolean } {
  const parsed = tomlParse(toml) as any;
  const muxObj = getOrCreatePath(parsed, muxPath);
  const k = normalizeKeySegment(caseValue);
  if (muxObj[k]) {
    return { toml, didAdd: false };
  }
  const caseObj: Record<string, any> = {};
  if (notes) {
    caseObj.notes = notes;
  }
  muxObj[k] = caseObj;
  return { toml: tomlStringify(parsed), didAdd: true };
}

/**
 * Delete a mux case from a mux object.
 * `muxPath` points directly to the mux object (including "mux").
 */
export function deleteMuxCaseToml(toml: string, muxPath: string[], caseValue: string): string {
  const parsed = tomlParse(toml) as any;
  const muxObj = getContainerAtPath(parsed, muxPath);
  const k = normalizeKeySegment(caseValue);
  if (muxObj && typeof muxObj === "object" && Object.prototype.hasOwnProperty.call(muxObj, k)) {
    delete muxObj[k];
  }
  return tomlStringify(parsed);
}

/**
 * Edit a mux case - rename and/or update notes.
 * `muxPath` points directly to the mux object (including "mux").
 * `oldCaseValue` is the current case key.
 * `newCaseValue` is the new case key (can be the same if only updating notes).
 * `notes` is the new notes value (undefined to remove notes).
 */
export function editMuxCaseToml(
  toml: string,
  muxPath: string[],
  oldCaseValue: string,
  newCaseValue: string,
  notes?: string
): { toml: string; success: boolean; error?: string } {
  const parsed = tomlParse(toml) as any;
  const muxObj = getContainerAtPath(parsed, muxPath);

  if (!muxObj || typeof muxObj !== "object") {
    return { toml, success: false, error: "Mux not found" };
  }

  const oldKey = normalizeKeySegment(oldCaseValue);
  const newKey = normalizeKeySegment(newCaseValue);

  if (!Object.prototype.hasOwnProperty.call(muxObj, oldKey)) {
    return { toml, success: false, error: `Case ${oldCaseValue} not found` };
  }

  // Check if renaming to an existing key (that isn't the same case)
  if (oldKey !== newKey && Object.prototype.hasOwnProperty.call(muxObj, newKey)) {
    return { toml, success: false, error: `Case ${newCaseValue} already exists` };
  }

  // Get the existing case data
  const caseData = muxObj[oldKey];

  // Update notes
  if (notes) {
    caseData.notes = notes;
  } else {
    delete caseData.notes;
  }

  // Handle rename if needed
  if (oldKey !== newKey) {
    // Create new key with the data, delete old key
    muxObj[newKey] = caseData;
    delete muxObj[oldKey];
  }

  return { toml: tomlStringify(parsed), success: true };
}

export function addNodeToml(toml: string, nodeName: string, notes?: string): string {
  const parsed = tomlParse(toml) as any;
  const node = ensureObject(parsed, "node");
  if (!node[nodeName]) {
    const nodeObj: Record<string, any> = {};
    if (notes) {
      nodeObj.notes = notes;
    }
    node[nodeName] = nodeObj;
  }

  const sortedNode: Record<string, any> = {};
  for (const key of Object.keys(node).sort(numericKeyCompare)) {
    sortedNode[key] = node[key];
  }
  parsed.node = sortedNode;

  return tomlStringify(parsed);
}

export function deleteNodeToml(toml: string, nodeName: string): string {
  const parsed = tomlParse(toml) as any;
  const nodes = parsed?.node;
  if (nodes && typeof nodes === "object") {
    delete nodes[normalizeKeySegment(nodeName)];
    parsed.node = sortObjectKeysNumeric(nodes);
  }
  return tomlStringify(parsed);
}

/**
 * Edit a node - rename and/or update notes.
 * If renamed, updates all frame transmitter references to the new name.
 */
export function editNodeToml(
  toml: string,
  oldName: string,
  newName: string,
  notes?: string
): { toml: string; success: boolean; error?: string } {
  const parsed = tomlParse(toml) as any;
  const nodes = parsed?.node;

  if (!nodes || typeof nodes !== "object") {
    return { toml, success: false, error: "No nodes section found" };
  }

  const oldKey = normalizeKeySegment(oldName);
  const newKey = normalizeKeySegment(newName);

  if (!Object.prototype.hasOwnProperty.call(nodes, oldKey)) {
    return { toml, success: false, error: `Node ${oldName} not found` };
  }

  // Check if renaming to an existing key (that isn't the same node)
  if (oldKey !== newKey && Object.prototype.hasOwnProperty.call(nodes, newKey)) {
    return { toml, success: false, error: `Node ${newName} already exists` };
  }

  // Get the existing node data
  const nodeData = nodes[oldKey] || {};

  // Update notes
  if (notes) {
    nodeData.notes = notes;
  } else {
    delete nodeData.notes;
  }

  // Handle rename if needed
  if (oldKey !== newKey) {
    // Create new key with the data, delete old key
    nodes[newKey] = nodeData;
    delete nodes[oldKey];

    // Update all frame transmitter references
    const canFrames = parsed?.frame?.can;
    if (canFrames && typeof canFrames === "object") {
      for (const frameVal of Object.values<any>(canFrames)) {
        if (frameVal?.transmitter === oldName) {
          frameVal.transmitter = newName;
        }
      }
    }

    // Sort nodes
    parsed.node = sortObjectKeysNumeric(nodes);
  }

  return { toml: tomlStringify(parsed), success: true };
}

/**
 * Generic delete by path. Removes the final segment from its parent (object or array).
 */
export function deleteTomlAtPath(toml: string, path: string[]): string {
  if (path.length === 0) return toml;

  const parsed = tomlParse(toml) as any;
  const parentPath = path.slice(0, -1);
  const lastSeg = normalizeKeySegment(path[path.length - 1]);
  const parent = getContainerAtPath(parsed, parentPath);

  if (parent === undefined || parent === null) return tomlStringify(parsed);

  if (Array.isArray(parent)) {
    const idx = Number(lastSeg);
    if (!Number.isNaN(idx) && idx >= 0 && idx < parent.length) {
      parent.splice(idx, 1);
    }
    return tomlStringify(parsed);
  }

  if (typeof parent === "object" && Object.prototype.hasOwnProperty.call(parent, lastSeg)) {
    delete (parent as any)[lastSeg];
  }

  return tomlStringify(parsed);
}

// ============================================================================
// Checksum Operations
// ============================================================================

export interface ChecksumData {
  name: string;
  algorithm: ChecksumAlgorithm;
  start_byte: number;
  byte_length: number;
  endianness?: "little" | "big";
  calc_start_byte: number;
  calc_end_byte: number;
  notes?: string;
}

/**
 * Upsert a checksum in the target frame's checksum array.
 * `checksumParentPath` points to the frame that owns the checksum array (e.g., ["frame", "serial", "0x01"]).
 * If `index` is provided, updates existing checksum at that index; otherwise adds a new one.
 */
export function upsertChecksumToml(
  toml: string,
  checksumParentPath: string[],
  checksum: ChecksumData,
  index: number | null
): string {
  const parsed = tomlParse(toml) as any;
  const target = getOrCreatePath(parsed, checksumParentPath);
  const checksums = ensureArray(target, "checksum");

  // Build checksum object with only non-default fields
  const data: ChecksumDefinition = {
    name: checksum.name,
    algorithm: checksum.algorithm,
    start_byte: checksum.start_byte,
    byte_length: checksum.byte_length,
    calc_start_byte: checksum.calc_start_byte,
    calc_end_byte: checksum.calc_end_byte,
  };

  // Only include optional fields if set
  if (checksum.endianness && checksum.byte_length > 1) {
    data.endianness = checksum.endianness;
  }
  if (checksum.notes) {
    data.notes = checksum.notes;
  }

  if (index !== null && index >= 0 && index < checksums.length) {
    checksums[index] = data;
  } else {
    checksums.push(data);
  }

  // Sort checksums by start_byte for consistent ordering
  checksums.sort((a: any, b: any) => {
    const aStart = a.start_byte ?? 0;
    const bStart = b.start_byte ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  });

  return tomlStringify(parsed);
}

/**
 * Delete a checksum from the target frame's checksum array.
 * `checksumParentPath` points to the frame that owns the checksum array.
 */
export function deleteChecksumToml(toml: string, checksumParentPath: string[], index: number): string {
  const parsed = tomlParse(toml) as any;
  const target = getContainerAtPath(parsed, checksumParentPath);

  if (target && Array.isArray(target.checksum) && index >= 0 && index < target.checksum.length) {
    target.checksum.splice(index, 1);

    // Remove empty checksum array
    if (target.checksum.length === 0) {
      delete target.checksum;
    }
  }

  return tomlStringify(parsed);
}
