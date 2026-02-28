// ui/src/apps/catalog/toml.ts

import TOML from "smol-toml";
import type { MetaFields, ParsedCatalogTree, TomlNode, TomlNodeType, ProtocolType, CanProtocolConfig, ModbusProtocolConfig, SerialProtocolConfig, SerialEncoding, ChecksumDefinition, CanHeaderField, SerialHeaderField, HeaderFieldFormat, SerialChecksumConfig, ChecksumAlgorithm } from "./types";
import { protocolRegistry, type ProtocolDefaults } from "./protocols";
import { isMuxCaseKey, sortMuxCaseKeys } from "../../utils/muxCaseMatch";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Map protocol type to TomlNodeType for frames
 */
function getFrameNodeType(protocol: ProtocolType): TomlNodeType {
  switch (protocol) {
    case "can":
      return "can-frame";
    case "modbus":
      return "modbus-frame";
    case "serial":
      return "serial-frame";
    default:
      return "section";
  }
}

/**
 * Count signals in a mux tree (recursive)
 */
function countMuxSignals(muxObj: any): number {
  let count = 0;
  for (const k in muxObj) {
    if (k === "name" || k === "start_bit" || k === "bit_length" || k === "default") continue;
    const caseVal = muxObj[k];
    if (typeof caseVal === "object") {
      if (caseVal.signals) count += caseVal.signals.length;
      if (caseVal.mux) count += countMuxSignals(caseVal.mux);
    }
  }
  return count;
}

function sortedMuxCaseKeysLocal(muxObj: Record<string, unknown>): string[] {
  const keys = Object.keys(muxObj).filter(isMuxCaseKey);
  return sortMuxCaseKeys(keys);
}

/**
 * Stringify with quoting fixes for TOML table headers like:
 * [canid.0x123] -> [canid."0x123"]
 *
 * Keys starting with digits or containing special chars must be quoted per TOML spec
 *
 * Also converts hex marker strings ("__HEX__0xFF00") to actual hex literals (0xFF00)
 */
export function tomlStringify(obj: any): string {
  let toml = TOML.stringify(obj);

  // Quote table headers with numeric-like keys
  toml = toml.replace(/\[([^\]]+)\]/g, (_match, path) => {
    const parts = path.split(".");
    const quotedParts = parts.map((part: string) => {
      if (part.startsWith('"') && part.endsWith('"')) return part;
      if (/^[0-9]/.test(part) || part.startsWith("0x")) {
        return `"${part}"`;
      }
      return part;
    });
    return `[${quotedParts.join(".")}]`;
  });

  // Convert hex marker strings to actual hex literals
  // Matches: mask = "__HEX__0xFF00" -> mask = 0xFF00
  // Also handles single quotes: mask = '__HEX__0xFF00' -> mask = 0xFF00
  toml = toml.replace(/["']__HEX__(0x[0-9A-Fa-f]+)["']/g, '$1');

  // Convert decimal mask values to hex format (skip values already in hex)
  // This ensures masks are always displayed as hex in the TOML output
  // Matches: mask = 65535 -> mask = 0xFFFF
  // Does NOT match: mask = 0xFFFF (already hex)
  toml = toml.replace(/((?:mask|frame_id_mask)\s*=\s*)(\d+)(?!\s*x)/g, (_match, prefix, numStr) => {
    // Skip if this looks like part of a hex number (the \d+ matched just "0" from "0x...")
    if (numStr === '0') {
      // Check if there's an 'x' following - if so, it's already hex, don't transform
      return _match;
    }
    const num = parseInt(numStr, 10);
    return `${prefix}0x${num.toString(16).toUpperCase()}`;
  });

  return toml;
}

export function tomlParse(text: string): any {
  return TOML.parse(text);
}


function coerceMetaFields(metaValue: any): MetaFields {
  return {
    name: metaValue?.name || "",
    version: metaValue?.version || 1,
    // Protocol-specific configs are in [meta.can], [meta.serial], [meta.modbus]
  };
}

/**
 * Parse CAN header fields from [meta.can.fields] section
 */
function parseCanHeaderFields(fieldsSection: any): Record<string, CanHeaderField> | undefined {
  if (!isPlainObject(fieldsSection)) return undefined;

  const fields: Record<string, CanHeaderField> = {};
  const validFormats: HeaderFieldFormat[] = ["hex", "decimal"];

  for (const [name, fieldDef] of Object.entries(fieldsSection)) {
    if (!isPlainObject(fieldDef)) continue;

    // mask is required
    const mask = (fieldDef as any).mask;
    if (typeof mask !== "number") continue;

    const field: CanHeaderField = { mask };

    // shift is optional (default: 0)
    const shift = (fieldDef as any).shift;
    if (typeof shift === "number") {
      field.shift = shift;
    }

    // format is optional (default: hex)
    const format = (fieldDef as any).format;
    if (validFormats.includes(format)) {
      field.format = format as HeaderFieldFormat;
    }

    fields[name] = field;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Parse [meta.can] section if present
 */
function parseCanConfig(parsed: any): CanProtocolConfig | undefined {
  const configSection = parsed?.meta?.can;
  if (!configSection || typeof configSection !== "object") return undefined;

  // Support both new key (default_byte_order) and old key (default_endianness) for backwards compatibility
  const byteOrderValue = configSection.default_byte_order ?? configSection.default_endianness;
  const defaultEndianness = byteOrderValue === "big" ? "big" as const
    : byteOrderValue === "little" ? "little" as const
    : undefined;

  // default_endianness is required
  if (!defaultEndianness) return undefined;

  const config: CanProtocolConfig = { default_endianness: defaultEndianness };

  // default_interval is optional
  if (typeof configSection.default_interval === "number") {
    config.default_interval = configSection.default_interval;
  }

  // frame_id_mask is optional (e.g., 0x1FFFFF00 for J1939)
  if (typeof configSection.frame_id_mask === "number") {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  // default_extended is optional (default: false = 11-bit standard)
  if (typeof configSection.default_extended === "boolean") {
    config.default_extended = configSection.default_extended;
  }

  // default_fd is optional (default: false = classic CAN)
  if (typeof configSection.default_fd === "boolean") {
    config.default_fd = configSection.default_fd;
  }

  // Parse header fields from [meta.can.fields]
  const fields = parseCanHeaderFields(configSection.fields);
  if (fields) {
    config.fields = fields;
  }

  return config;
}

/**
 * Parse [meta.modbus] section if present
 */
function parseModbusConfig(parsed: any): ModbusProtocolConfig | undefined {
  const configSection = parsed?.meta?.modbus;
  if (!configSection || typeof configSection !== "object") return undefined;

  const deviceAddress = typeof configSection.device_address === "number"
    ? configSection.device_address
    : undefined;
  const registerBase = configSection.register_base === 0 || configSection.register_base === 1
    ? configSection.register_base as 0 | 1
    : undefined;

  // Both fields must be present for a valid config
  if (deviceAddress === undefined || registerBase === undefined) return undefined;

  const config: ModbusProtocolConfig = { device_address: deviceAddress, register_base: registerBase };

  // default_interval is optional
  if (typeof configSection.default_interval === "number") {
    config.default_interval = configSection.default_interval;
  }

  // default_byte_order is optional
  const byteOrder = configSection.default_byte_order ?? configSection.byte_order;
  if (byteOrder === "big" || byteOrder === "little") {
    config.default_byte_order = byteOrder;
  }

  // default_word_order is optional
  const wordOrder = configSection.default_word_order;
  if (wordOrder === "big" || wordOrder === "little") {
    config.default_word_order = wordOrder;
  }

  return config;
}

/**
 * Convert legacy start_byte + bytes to mask
 * E.g., start_byte=0, bytes=2 -> 0xFFFF (first 2 bytes)
 *       start_byte=2, bytes=1 -> 0x00FF0000 (third byte)
 */
function legacyFieldToMask(startByte: number, numBytes: number = 1): number {
  // Create a mask of numBytes * 8 bits, shifted to the right position
  // Note: bytes are stored big-endian in the mask (byte 0 = highest bits)
  const bitsPerByte = 8;
  const numBits = numBytes * bitsPerByte;
  const mask = ((1 << numBits) - 1) >>> 0;  // numBytes worth of 1s
  // Shift to correct position (byte 0 = most significant)
  return (mask << (startByte * bitsPerByte)) >>> 0;
}

/**
 * Parse Serial header fields from [meta.serial.fields] section
 * Supports both new mask format and legacy start_byte/bytes format
 */
function parseSerialHeaderFields(fieldsSection: any): Record<string, SerialHeaderField> | undefined {
  if (!isPlainObject(fieldsSection)) return undefined;

  const fields: Record<string, SerialHeaderField> = {};
  const validFormats: HeaderFieldFormat[] = ["hex", "decimal"];

  for (const [name, fieldDef] of Object.entries(fieldsSection)) {
    if (!isPlainObject(fieldDef)) continue;

    let mask: number;

    // New format: mask is directly specified
    if (typeof (fieldDef as any).mask === "number") {
      mask = (fieldDef as any).mask;
    }
    // Legacy format: convert start_byte + bytes to mask
    else if (typeof (fieldDef as any).start_byte === "number") {
      const startByte = (fieldDef as any).start_byte;
      const bytes = typeof (fieldDef as any).bytes === "number" ? (fieldDef as any).bytes : 1;
      mask = legacyFieldToMask(startByte, bytes);
    }
    // Invalid: neither mask nor start_byte specified
    else {
      continue;
    }

    const field: SerialHeaderField = { mask };

    // endianness is optional (default: big)
    const endianness = (fieldDef as any).endianness;
    if (endianness === "big" || endianness === "little") {
      field.endianness = endianness;
    }

    // format is optional (default: hex)
    const format = (fieldDef as any).format;
    if (validFormats.includes(format)) {
      field.format = format as HeaderFieldFormat;
    }

    fields[name] = field;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Parse [meta.serial.checksum] section if present
 */
function parseSerialChecksumConfig(checksumSection: any): SerialChecksumConfig | undefined {
  if (!isPlainObject(checksumSection)) return undefined;

  // algorithm and start_byte are required
  const algorithm = checksumSection.algorithm as string;
  const startByte = checksumSection.start_byte;
  if (typeof algorithm !== "string" || typeof startByte !== "number") return undefined;

  const config: SerialChecksumConfig = {
    algorithm: algorithm as ChecksumAlgorithm,
    start_byte: startByte,
    byte_length: typeof checksumSection.byte_length === "number" ? checksumSection.byte_length : 1,
    calc_start_byte: typeof checksumSection.calc_start_byte === "number" ? checksumSection.calc_start_byte : 0,
    calc_end_byte: typeof checksumSection.calc_end_byte === "number" ? checksumSection.calc_end_byte : -1,
  };

  // big_endian is optional (default: false)
  if (typeof checksumSection.big_endian === "boolean") {
    config.big_endian = checksumSection.big_endian;
  }

  return config;
}

/**
 * Parse [meta.serial] section if present
 */
function parseSerialConfig(parsed: any): SerialProtocolConfig | undefined {
  const configSection = parsed?.meta?.serial;
  if (!configSection || typeof configSection !== "object") return undefined;

  const validEncodings: SerialEncoding[] = ["slip", "cobs", "raw", "length_prefixed"];
  const encoding = validEncodings.includes(configSection.encoding)
    ? configSection.encoding as SerialEncoding
    : undefined;

  if (!encoding) return undefined;

  const config: SerialProtocolConfig = { encoding };

  // byte_order is optional (default byte order for signal decoding)
  if (configSection.byte_order === "little" || configSection.byte_order === "big") {
    config.byte_order = configSection.byte_order;
  }

  // frame_id_mask is optional (e.g., 0xFF00 to match on TYPE only, ignore COMMAND)
  if (typeof configSection.frame_id_mask === "number") {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  // Parse header fields from [meta.serial.fields]
  const fields = parseSerialHeaderFields(configSection.fields);
  if (fields) {
    config.fields = fields;
  }

  // header_length is optional (global header size for all frames)
  if (typeof configSection.header_length === "number") {
    config.header_length = configSection.header_length;
  }

  // max_frame_length is optional (default: 64 in backend)
  if (typeof configSection.max_frame_length === "number") {
    config.max_frame_length = configSection.max_frame_length;
  }

  // Parse [meta.serial.checksum] subsection
  const checksum = parseSerialChecksumConfig(configSection.checksum);
  if (checksum) {
    config.checksum = checksum;
  }

  return config;
}

/**
 * Parse TOML text into a UI tree plus extracted metadata.
 * This is PURE (no React state updates).
 */
export function parseTomlToTree(content: string): ParsedCatalogTree {
  try {
    const parsed = TOML.parse(content) as any;
    const meta = isPlainObject(parsed?.meta) ? coerceMetaFields(parsed.meta) : null;
    const canConfig = parseCanConfig(parsed);
    const modbusConfig = parseModbusConfig(parsed);
    const serialConfig = parseSerialConfig(parsed);

    const peers = isPlainObject(parsed?.node) ? Object.keys(parsed.node) : [];

    // Detect which protocol frames exist
    const canSection = parsed?.frame?.can;
    const modbusSection = parsed?.frame?.modbus;
    const serialSection = parsed?.frame?.serial;

    // Count frames (config is now in meta, not under frame.protocol)
    const hasCanFrames = isPlainObject(canSection) && Object.keys(canSection).length > 0;
    const hasModbusFrames = isPlainObject(modbusSection) && Object.keys(modbusSection).length > 0;
    const hasSerialFrames = isPlainObject(serialSection) && Object.keys(serialSection).length > 0;

    const tree = objectToTree(parsed, [], meta, canConfig, modbusConfig, serialConfig);
    return { tree, meta, peers, canConfig, modbusConfig, serialConfig, hasCanFrames, hasModbusFrames, hasSerialFrames };
  } catch (error) {
    console.error("Failed to parse TOML:", error);
    return { tree: [], meta: null, peers: [] };
  }
}

function objectToTree(obj: any, parentPath: string[], meta: MetaFields | null, canConfig?: CanProtocolConfig, modbusConfig?: ModbusProtocolConfig, serialConfig?: SerialProtocolConfig): TomlNode[] {
  const nodes: TomlNode[] = [];

  for (const [key, value] of Object.entries(obj || {})) {
    const path = [...parentPath, key];

    // meta section (flat)
    if (key === "meta" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      nodes.push({
        key: "meta",
        type: "meta",
        path: ["meta"],
        metadata: {
          isMeta: true,
          properties: value as Record<string, any>,
        },
      });
      continue;
    }

    // peer section (node)
    if (key === "node" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const peerValue = value as any;
      const children: TomlNode[] = Object.entries(peerValue).map(([peerKey, peerVal]) => ({
        key: peerKey,
        type: "node",
        path: [...path, peerKey],
        metadata: {
          isNode: true,
          properties: peerVal as Record<string, any>,
        },
      }));

      nodes.push({
        key: "node",
        type: "section",
        path: ["node"],
        children,
        metadata: {
          properties: peerValue as Record<string, any>,
        },
      });
      continue;
    }

    // frame section
    if (key === "frame" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const frameValue = value as any;
      const frameSectionChildren: TomlNode[] = [];

      // Build defaults from protocol configs for handlers
      const defaults: ProtocolDefaults = {
        // CAN config from [meta.can]
        default_interval: canConfig?.default_interval,
        default_endianness: canConfig?.default_endianness,
        default_extended: canConfig?.default_extended,
        default_fd: canConfig?.default_fd,
        // Modbus config from [meta.modbus]
        modbusDeviceAddress: modbusConfig?.device_address,
        modbusRegisterBase: modbusConfig?.register_base,
        modbusDefaultInterval: modbusConfig?.default_interval,
        modbusDefaultByteOrder: modbusConfig?.default_byte_order,
        modbusDefaultWordOrder: modbusConfig?.default_word_order,
        // Serial config from [meta.serial]
        serialEncoding: serialConfig?.encoding,
      };

      // Build mux tree (protocol-agnostic)
      const buildMuxTree = (muxObj: any, muxPath: string[], framePath: string[]): TomlNode[] => {
        const muxCaseNodes: TomlNode[] = [];

        const muxRecord = muxObj as Record<string, unknown>;
        for (const k of sortedMuxCaseKeysLocal(muxRecord)) {
          const caseVal = (muxRecord as any)[k];
          if (typeof caseVal === "object") {
            const caseChildren: TomlNode[] = [];

            if (caseVal.signals && Array.isArray(caseVal.signals)) {
              caseVal.signals.forEach((signal: any, idx: number) => {
                caseChildren.push({
                  key: signal.name || `Signal ${idx + 1}`,
                  type: "signal" as const,
                  path: [...framePath, "mux", ...muxPath, k, "signals", String(idx)],
                  metadata: {
                    signalIndex: idx,
                    signalStartBit: signal.start_bit,
                    signalBitLength: signal.bit_length,
                    properties: signal,
                  },
                });
              });
            }

            caseChildren.sort((a, b) => {
              const aStart = a.metadata?.muxStartBit ?? a.metadata?.signalStartBit ?? 0;
              const bStart = b.metadata?.muxStartBit ?? b.metadata?.signalStartBit ?? 0;
              return aStart - bStart;
            });

            if (caseVal.mux && typeof caseVal.mux === "object") {
              const nestedMuxNode: TomlNode = {
                key: caseVal.mux.name || "Mux",
                type: "mux",
                path: [...framePath, "mux", ...muxPath, k, "mux"],
                children: buildMuxTree(caseVal.mux, [...muxPath, k, "mux"], framePath),
                metadata: {
                  muxName: caseVal.mux.name,
                  muxStartBit: caseVal.mux.start_bit,
                  muxBitLength: caseVal.mux.bit_length,
                  muxDefaultCase: caseVal.mux.default,
                  properties: caseVal.mux,
                },
              };
              caseChildren.push(nestedMuxNode);
            }

            muxCaseNodes.push({
              key: `Case ${k}`,
              type: "mux-case",
              path: [...framePath, "mux", ...muxPath, k],
              children: caseChildren.length > 0 ? caseChildren : undefined,
              metadata: {
                caseValue: k,
                properties: caseVal,
              },
            });
          }
        }

        return muxCaseNodes;
      };

      // Build signal children (protocol-agnostic)
      const buildSignalChildren = (signals: any[], framePath: string[]): TomlNode[] => {
        return signals.map((signal: any, idx: number) => ({
          key: signal.name || `Signal ${idx + 1}`,
          type: "signal" as const,
          path: [...framePath, "signals", String(idx)],
          metadata: {
            signalIndex: idx,
            signalStartBit: signal.start_bit,
            signalBitLength: signal.bit_length,
            properties: signal,
          },
        }));
      };

      // Build checksum children (protocol-agnostic)
      const buildChecksumChildren = (checksums: ChecksumDefinition[], framePath: string[]): TomlNode[] => {
        return checksums.map((checksum: ChecksumDefinition, idx: number) => ({
          key: checksum.name || `Checksum ${idx + 1}`,
          type: "checksum" as const,
          path: [...framePath, "checksum", String(idx)],
          metadata: {
            checksumIndex: idx,
            checksumAlgorithm: checksum.algorithm,
            checksumStartByte: checksum.start_byte,
            checksumByteLength: checksum.byte_length,
            checksumEndianness: checksum.endianness,
            checksumCalcStartByte: checksum.calc_start_byte,
            checksumCalcEndByte: checksum.calc_end_byte,
            properties: checksum,
          },
        }));
      };

      // Sort children by start bit
      const sortByStartBit = (children: TomlNode[]): TomlNode[] => {
        return children.sort((a, b) => {
          const aStart = a.metadata?.muxStartBit ?? a.metadata?.signalStartBit ?? 0;
          const bStart = b.metadata?.muxStartBit ?? b.metadata?.signalStartBit ?? 0;
          return aStart - bStart;
        });
      };

      // Iterate over all protocol sections using the registry
      for (const protocolKey of Object.keys(frameValue)) {
        const protocolFrames = frameValue[protocolKey];
        if (!protocolFrames || typeof protocolFrames !== "object") continue;

        // Check if this is a registered protocol
        if (!protocolRegistry.has(protocolKey)) continue;

        const protocol = protocolKey as ProtocolType;
        const handler = protocolRegistry.get(protocol);
        if (!handler) continue;

        const frameChildren: TomlNode[] = [];

        Object.entries(protocolFrames).forEach(([frameKey, frameVal]: [string, any]) => {
          // Protocol configs are now in [meta.protocol], not under [frame.protocol.config]
          const framePath = ["frame", protocol, frameKey];
          const allChildren: TomlNode[] = [];

          // Use protocol handler to parse frame
          const parsed = handler.parseFrame(frameKey, frameVal, defaults, protocolFrames);

          // Build mux tree if present
          if (parsed.base.mux && typeof parsed.base.mux === "object") {
            const muxNode: TomlNode = {
              key: parsed.base.mux.name || "Mux",
              type: "mux",
              path: [...framePath, "mux"],
              children: buildMuxTree(parsed.base.mux, [], framePath),
              metadata: {
                muxName: parsed.base.mux.name,
                muxStartBit: parsed.base.mux.start_bit,
                muxBitLength: parsed.base.mux.bit_length,
                muxDefaultCase: parsed.base.mux.default,
                properties: parsed.base.mux,
              },
            };
            allChildren.push(muxNode);
          }

          // Build signal children
          if (parsed.base.signals && parsed.base.signals.length > 0) {
            allChildren.push(...buildSignalChildren(parsed.base.signals, framePath));
          }

          // Build checksum children (checksums are in frameVal.checksum array)
          const checksums = frameVal?.checksum;
          if (Array.isArray(checksums) && checksums.length > 0) {
            allChildren.push(...buildChecksumChildren(checksums, framePath));
          }

          // Sort by start bit
          sortByStartBit(allChildren);

          // Calculate mux signal count
          const hasMux = !!parsed.base.mux;
          const muxSignalCount = hasMux ? countMuxSignals(parsed.base.mux) : 0;

          // Build metadata based on protocol type
          // Keep backward-compatible metadata fields for existing views
          const metadata: Record<string, any> = {
            frameType: protocol,
            isId: true,
            idValue: frameKey,
            length: parsed.base.length,
            lengthInherited: parsed.inherited.length,
            transmitter: parsed.base.transmitter,
            transmitterInherited: parsed.inherited.transmitter,
            interval: parsed.base.interval,
            intervalInherited: parsed.inherited.interval,
            notes: parsed.base.notes,
            signals: parsed.base.signals,
            checksums: Array.isArray(checksums) ? checksums : undefined,
            hasMux,
            muxSignalCount,
            properties: frameVal as Record<string, any>,
          };

          // Add protocol-specific metadata
          if (protocol === "can") {
            const canConfig = parsed.config as import("./types").CANConfig;
            metadata.isCopy = !!canConfig.copy;
            metadata.copyFrom = canConfig.copy;
            metadata.isMirror = !!canConfig.mirror_of;
            metadata.mirrorOf = canConfig.mirror_of;
            metadata.extended = canConfig.extended;
            metadata.extendedInherited = parsed.inherited.extended;
            metadata.fd = canConfig.fd;
            metadata.fdInherited = parsed.inherited.fd;
            metadata.bus = canConfig.bus;
          } else if (protocol === "modbus") {
            const modbusConfig = parsed.config as import("./types").ModbusConfig;
            metadata.registerNumber = modbusConfig.register_number;
            metadata.deviceAddress = modbusConfig.device_address;
            metadata.deviceAddressInherited = parsed.inherited.deviceAddress;
            metadata.registerType = modbusConfig.register_type;
            metadata.registerBase = modbusConfig.register_base;
            metadata.registerBaseInherited = parsed.inherited.registerBase;
          } else if (protocol === "serial") {
            const serialFrameConfig = parsed.config as import("./types").SerialConfig;
            // Encoding comes from [frame.serial.config], not per-frame
            metadata.encoding = defaults.serialEncoding;
            metadata.frameId = serialFrameConfig.frame_id;
            metadata.delimiter = serialFrameConfig.delimiter;
          }

          frameChildren.push({
            key: frameKey,
            type: getFrameNodeType(protocol),
            path: framePath,
            children: allChildren.length > 0 ? allChildren : undefined,
            metadata,
          });
        });

        frameSectionChildren.push({
          key: protocol,
          type: "section",
          path: ["frame", protocol],
          children: frameChildren,
          metadata: { properties: protocolFrames as Record<string, any> },
        });
      }

      nodes.push({
        key: "frame",
        type: "section",
        path: ["frame"],
        children: frameSectionChildren,
        metadata: { properties: frameValue as Record<string, any> },
      });
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object" && !Array.isArray(value[0])) {
        const children: TomlNode[] = value.map((item, index) => {
          const signalName = (item as any).name || `Item ${index + 1}`;
          const itemNode: TomlNode = {
            key: signalName,
            type: "signal",
            path: [...path, String(index)],
            children: [],
            metadata: { signalIndex: index, properties: item },
          };

          for (const [propKey, propValue] of Object.entries(item)) {
            if (propKey !== "name") {
              itemNode.children!.push({
                key: propKey,
                type: "value",
                value: propValue,
                path: [...path, String(index), propKey],
              });
            }
          }

          return itemNode;
        });

        nodes.push({
          key,
          type: "table-array",
          path,
          children,
          metadata: { isArray: true, arrayItems: value },
        });
      } else {
        nodes.push({
          key,
          type: "array",
          value: JSON.stringify(value, null, 2),
          path,
          metadata: { isArray: true, arrayItems: value },
        });
      }
    } else if (typeof value === "object" && value !== null) {
      const isCopy = "copy" in (value as any);
      const copyFrom = isCopy ? String((value as any).copy) : undefined;
      const children = objectToTree(value, path, meta);

      nodes.push({
        key,
        type: "section",
        path,
        children,
        metadata: { isCopy, copyFrom, properties: value as any },
      });
    } else {
      nodes.push({
        key,
        type: "value",
        value: String(value),
        path,
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.key === "meta") return -1;
    if (b.key === "meta") return 1;
    return a.key.localeCompare(b.key);
  });

  return nodes;
}
