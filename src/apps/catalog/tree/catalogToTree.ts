// ui/src/apps/catalog/tree/catalogToTree.ts
//
// Builds the Catalog Editor's `TomlNode[]` sidebar tree from the Rust-resolved
// `Catalog` model (the `catalog.parse` WS command), replacing the legacy
// TypeScript parser in `toml.ts`. Rust is the single source of truth for
// catalogue semantics (ids, register numbers, mirror/copy inheritance, mux
// resolution); this module is a pure presentational projection of that model
// onto the `TomlNode` contract the rest of the editor consumes.
//
// The node `path`, `type`, `key` and `metadata` shapes are reproduced exactly
// so selection, find, frame grouping, the edit views and the comment-preserving
// `catalog.edit` ops (which target the TOML document by path) keep working.

import { isMuxCaseKey, sortMuxCaseKeys } from "../../../utils/muxCaseMatch";
import type {
  Catalog,
  Frame,
  Signal,
  Mux,
  MuxCase,
  FrameChecksum,
  NodeDef,
} from "../../../types/catalogModel";
import type {
  TomlNode,
  TomlNodeType,
  ProtocolType,
  ParsedCatalogTree,
  MetaFields,
  CanProtocolConfig,
  ModbusProtocolConfig,
  SerialProtocolConfig,
} from "../types";

function frameNodeType(protocol: ProtocolType): TomlNodeType {
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

/** Strip `undefined`-valued keys so reconstructed objects stay tidy. */
function defined<T extends Record<string, any>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/**
 * Project a resolved {@link Signal} back to its catalogue (snake_case) authoring
 * object — the `metadata.properties` shape the signal edit form reads.
 */
function signalProps(s: Signal): Record<string, any> {
  return defined({
    name: s.name,
    start_bit: s.startBit,
    bit_length: s.bitLength,
    signed: s.signed,
    byte_order: s.endianness,
    word_order: s.wordOrder,
    factor: s.factor,
    offset: s.offset,
    unit: s.unit,
    min: s.min,
    max: s.max,
    format: s.format,
    enum: s.enum,
    confidence: s.confidence,
    modbus_register: s.modbusRegister,
    modbus_register_count: s.modbusRegisterCount,
  });
}

function muxProps(m: Mux): Record<string, any> {
  return defined({
    name: m.name,
    start_bit: m.startBit,
    bit_length: m.bitLength,
    default: m.default,
    notes: m.notes,
  });
}

/** Count signals across all mux cases, recursively (mirrors `countMuxSignals`). */
function countMuxSignals(m: Mux): number {
  let count = 0;
  for (const c of Object.values(m.cases)) {
    count += c.signals.length;
    if (c.mux) count += countMuxSignals(c.mux);
  }
  return count;
}

const startBitOf = (n: TomlNode) =>
  n.metadata?.muxStartBit ?? n.metadata?.signalStartBit ?? 0;
const byStartBit = (a: TomlNode, b: TomlNode) => startBitOf(a) - startBitOf(b);

/** `prefix` is the path between the frame and the `signals` array — `[]` for a
 *  frame's own signals, `["mux", …caseKeys]` for signals inside a mux case. */
function signalNode(s: Signal, idx: number, framePath: string[], prefix: string[]): TomlNode {
  return {
    key: s.name || `Signal ${idx + 1}`,
    type: "signal",
    path: [...framePath, ...prefix, "signals", String(idx)],
    metadata: {
      signalIndex: idx,
      signalStartBit: s.startBit,
      signalBitLength: s.bitLength,
      properties: signalProps(s),
    },
  };
}

/** Build a mux node and its case/nested-mux subtree at `muxPath` under the frame. */
function muxNode(m: Mux, framePath: string[], muxPath: string[]): TomlNode {
  const caseNodes: TomlNode[] = [];
  const orderedKeys = sortMuxCaseKeys(Object.keys(m.cases).filter(isMuxCaseKey));
  for (const k of orderedKeys) {
    const c: MuxCase = m.cases[k];
    const caseChildren: TomlNode[] = c.signals.map((s, idx) =>
      signalNode(s, idx, framePath, ["mux", ...muxPath, k]),
    );
    caseChildren.sort(byStartBit);
    if (c.mux) {
      caseChildren.push(muxNode(c.mux, framePath, [...muxPath, k, "mux"]));
    }
    caseNodes.push({
      key: `Case ${k}`,
      type: "mux-case",
      path: [...framePath, "mux", ...muxPath, k],
      children: caseChildren.length > 0 ? caseChildren : undefined,
      metadata: {
        caseValue: k,
        properties: defined({ signals: c.signals.map(signalProps), notes: c.notes }),
      },
    });
  }
  return {
    key: m.name || "Mux",
    type: "mux",
    path: [...framePath, "mux", ...muxPath],
    children: caseNodes,
    metadata: {
      muxName: m.name,
      muxStartBit: m.startBit,
      muxBitLength: m.bitLength,
      muxDefaultCase: m.default,
      properties: muxProps(m),
    },
  };
}

function checksumNode(c: FrameChecksum, idx: number, framePath: string[]): TomlNode {
  return {
    key: c.name || `Checksum ${idx + 1}`,
    type: "checksum",
    path: [...framePath, "checksum", String(idx)],
    metadata: {
      checksumIndex: idx,
      checksumAlgorithm: c.algorithm as any,
      checksumStartByte: c.startByte,
      checksumByteLength: c.byteLength,
      checksumEndianness: c.endianness,
      checksumCalcStartByte: c.calcStartByte,
      checksumCalcEndByte: c.calcEndByte,
      properties: defined({
        name: c.name,
        algorithm: c.algorithm,
        start_byte: c.startByte,
        byte_length: c.byteLength,
        endianness: c.endianness,
        calc_start_byte: c.calcStartByte,
        calc_end_byte: c.calcEndByte,
      }),
    },
  };
}

function frameNode(f: Frame, cat: Catalog): TomlNode {
  const framePath = ["frame", f.protocol, f.key];
  const inherited = new Set(f.inheritedFields ?? []);
  const children: TomlNode[] = [];

  if (f.mux) children.push(muxNode(f.mux, framePath, []));
  f.signals.forEach((s, idx) => children.push(signalNode(s, idx, framePath, [])));
  (f.checksums ?? []).forEach((c, idx) => children.push(checksumNode(c, idx, framePath)));
  children.sort(byStartBit);

  const metadata: TomlNode["metadata"] = {
    frameType: f.protocol,
    isId: true,
    idValue: f.key,
    length: f.length,
    lengthInherited: inherited.has("length"),
    transmitter: f.transmitter,
    transmitterInherited: inherited.has("transmitter"),
    interval: f.interval,
    intervalInherited: inherited.has("interval"),
    notes: f.notes,
    signals: f.signals.map(signalProps),
    hasMux: !!f.mux,
    muxSignalCount: f.mux ? countMuxSignals(f.mux) : 0,
  };

  if (f.protocol === "can") {
    metadata.isCopy = !!f.copyFrom;
    metadata.copyFrom = f.copyFrom;
    metadata.isMirror = !!f.mirrorOf;
    metadata.mirrorOf = f.mirrorOf;
    metadata.extended = f.isExtended;
    metadata.extendedInherited = inherited.has("extended");
    metadata.fd = f.isFd;
    metadata.fdInherited = inherited.has("fd");
    metadata.bus = f.bus;
  } else if (f.protocol === "modbus") {
    metadata.registerNumber = f.frameId;
    metadata.deviceAddress = cat.modbus?.deviceAddress ?? 1;
    metadata.deviceAddressInherited = inherited.has("deviceAddress");
    metadata.registerType = f.modbusRegisterType;
    metadata.registerBase = cat.modbus?.registerBase as 0 | 1 | undefined;
    metadata.registerBaseInherited = inherited.has("registerBase");
  } else if (f.protocol === "serial") {
    metadata.encoding = cat.serial?.encoding as any;
    metadata.frameId = f.key;
    metadata.delimiter = f.delimiter;
  }

  return {
    key: f.key,
    type: frameNodeType(f.protocol),
    path: framePath,
    children: children.length > 0 ? children : undefined,
    metadata,
  };
}

// ── config mappers (resolved model → editor's *ProtocolConfig shapes) ──

function toCanConfig(cat: Catalog): CanProtocolConfig | undefined {
  const c = cat.can;
  if (!c) return undefined;
  return defined({
    default_endianness: c.defaultByteOrder ?? "big",
    default_interval: c.defaultInterval,
    default_extended: c.defaultExtended,
    default_fd: c.defaultFd,
    frame_id_mask: c.frameIdMask,
    fields: c.fields
      ? Object.fromEntries(
          Object.entries(c.fields).map(([k, v]) => [
            k,
            defined({ mask: v.mask, shift: v.shift, format: v.format as any }),
          ]),
        )
      : undefined,
  }) as CanProtocolConfig;
}

function toModbusConfig(cat: Catalog): ModbusProtocolConfig | undefined {
  const m = cat.modbus;
  if (!m) return undefined;
  return defined({
    device_address: m.deviceAddress ?? 1,
    register_base: (m.registerBase ?? 0) as 0 | 1,
    default_interval: m.defaultInterval,
    default_byte_order: m.defaultByteOrder,
    default_word_order: m.defaultWordOrder,
  }) as ModbusProtocolConfig;
}

function toSerialConfig(cat: Catalog): SerialProtocolConfig | undefined {
  const s = cat.serial;
  if (!s) return undefined;
  return defined({
    encoding: (s.encoding ?? "raw") as any,
    byte_order: s.byteOrder,
    header_length: s.headerLength,
    max_frame_length: s.minFrameLength,
    frame_id_mask: s.frameIdMask,
    fields: s.fields
      ? Object.fromEntries(
          Object.entries(s.fields).map(([k, v]) => [
            k,
            defined({ mask: v.mask, endianness: v.endianness, format: v.format as any }),
          ]),
        )
      : undefined,
    checksum: s.checksum
      ? defined({
          algorithm: s.checksum.algorithm as any,
          start_byte: s.checksum.startByte,
          byte_length: s.checksum.byteLength,
          calc_start_byte: s.checksum.calcStartByte,
          calc_end_byte: s.checksum.calcEndByte ?? 0,
          big_endian: s.checksum.bigEndian,
        })
      : undefined,
  }) as SerialProtocolConfig;
}

function metaNode(cat: Catalog): TomlNode {
  return {
    key: "meta",
    type: "meta",
    path: ["meta"],
    metadata: {
      isMeta: true,
      properties: defined({ name: cat.meta.name, version: cat.meta.version }),
    },
  };
}

function nodeSection(nodes: NodeDef[]): TomlNode {
  const children: TomlNode[] = nodes.map((n) => ({
    key: n.name,
    type: "node",
    path: ["node", n.name],
    metadata: { isNode: true, properties: defined({ notes: n.notes }) },
  }));
  return {
    key: "node",
    type: "section",
    path: ["node"],
    children,
    metadata: { properties: {} },
  };
}

const PROTOCOLS: ProtocolType[] = ["can", "modbus", "serial"];

/**
 * Build the editor's parsed-tree view-model from a Rust-resolved {@link Catalog}.
 * Drop-in replacement for `parseTomlToTree`, sourced from `catalog.parse`.
 */
export function catalogToTree(cat: Catalog): ParsedCatalogTree {
  const tree: TomlNode[] = [];

  // [meta] — always present.
  tree.push(metaNode(cat));

  // [frame] → one section per protocol that has frames, each holding its frames.
  const frameSectionChildren: TomlNode[] = [];
  for (const protocol of PROTOCOLS) {
    const protoFrames = cat.frames.filter((f) => f.protocol === protocol);
    if (protoFrames.length === 0) continue;
    frameSectionChildren.push({
      key: protocol,
      type: "section",
      path: ["frame", protocol],
      children: protoFrames.map((f) => frameNode(f, cat)),
      metadata: { properties: {} },
    });
  }
  if (frameSectionChildren.length > 0) {
    tree.push({
      key: "frame",
      type: "section",
      path: ["frame"],
      children: frameSectionChildren,
      metadata: { properties: {} },
    });
  }

  // [node] peers.
  const nodes = cat.nodes ?? [];
  if (nodes.length > 0) tree.push(nodeSection(nodes));

  // Match the legacy top-level ordering: meta first, then alphabetical by key.
  tree.sort((a, b) => {
    if (a.key === "meta") return -1;
    if (b.key === "meta") return 1;
    return a.key.localeCompare(b.key);
  });

  const meta: MetaFields = { name: cat.meta.name, version: cat.meta.version };

  return {
    tree,
    meta,
    peers: nodes.map((n) => n.name),
    canConfig: toCanConfig(cat),
    modbusConfig: toModbusConfig(cat),
    serialConfig: toSerialConfig(cat),
    hasCanFrames: cat.frames.some((f) => f.protocol === "can"),
    hasModbusFrames: cat.frames.some((f) => f.protocol === "modbus"),
    hasSerialFrames: cat.frames.some((f) => f.protocol === "serial"),
  };
}
