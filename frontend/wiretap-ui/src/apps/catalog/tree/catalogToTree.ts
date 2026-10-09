// ui/src/apps/catalog/tree/catalogToTree.ts
//
// The Catalog Editor's sidebar tree over the served `Catalog`: each node is a
// path into the document (what the edit ops target) and the part of the model
// it shows. Nothing is renamed or re-derived here.

import { sortMuxCaseKeys } from "../../../utils/muxCaseMatch";
import type { Catalog, Frame, Signal, Mux, FrameChecksum, NodeDef } from "../../../types/catalogModel";
import type { TomlNode, TomlNodeType, ProtocolType } from "../types";

const FRAME_NODE_TYPE: Record<ProtocolType, TomlNodeType> = {
  can: "can-frame",
  modbus: "modbus-frame",
  serial: "serial-frame",
};

const startBitOf = (n: TomlNode) => n.metadata?.mux?.startBit ?? n.metadata?.signal?.startBit ?? 0;
const byStartBit = (a: TomlNode, b: TomlNode) => startBitOf(a) - startBitOf(b);

/** `prefix` is the path between the frame and `signals`: `[]` or `["mux", …cases]`. */
function signalNode(signal: Signal, index: number, framePath: string[], prefix: string[], inherited: boolean): TomlNode {
  return {
    key: signal.name || `Signal ${index + 1}`,
    type: "signal",
    path: [...framePath, ...prefix, "signals", String(index)],
    metadata: { signal, signalIndex: index, inherited: inherited || !!signal.inherited },
  };
}

function muxNode(mux: Mux, framePath: string[], muxPath: string[], inherited: boolean): TomlNode {
  const cases = sortMuxCaseKeys(Object.keys(mux.cases)).map((caseValue): TomlNode => {
    const muxCase = mux.cases[caseValue];
    const casePrefix = ["mux", ...muxPath, caseValue];
    const children = muxCase.signals.map((s, i) => signalNode(s, i, framePath, casePrefix, inherited)).sort(byStartBit);
    if (muxCase.mux) children.push(muxNode(muxCase.mux, framePath, [...muxPath, caseValue, "mux"], inherited));
    return {
      key: `Case ${caseValue}`,
      type: "mux-case",
      path: [...framePath, ...casePrefix],
      children: children.length > 0 ? children : undefined,
      metadata: { muxCase, caseValue, inherited },
    };
  });
  return {
    key: mux.name || "Mux",
    type: "mux",
    path: [...framePath, "mux", ...muxPath],
    children: cases,
    metadata: { mux, inherited },
  };
}

function checksumNode(checksum: FrameChecksum, index: number, framePath: string[]): TomlNode {
  return {
    key: checksum.name || `Checksum ${index + 1}`,
    type: "checksum",
    path: [...framePath, "checksum", String(index)],
    metadata: { checksum, checksumIndex: index },
  };
}

function frameNode(frame: Frame): TomlNode {
  const framePath = ["frame", frame.protocol, frame.key];
  const children: TomlNode[] = [];
  if (frame.mux) children.push(muxNode(frame.mux, framePath, [], !!frame.inheritedFields?.includes("mux")));
  frame.signals.forEach((s, i) => children.push(signalNode(s, i, framePath, [], false)));
  (frame.checksums ?? []).forEach((c, i) => children.push(checksumNode(c, i, framePath)));
  children.sort(byStartBit);
  return {
    key: frame.key,
    type: FRAME_NODE_TYPE[frame.protocol],
    path: framePath,
    children: children.length > 0 ? children : undefined,
    metadata: { frame },
  };
}

function nodeSection(nodes: NodeDef[]): TomlNode {
  return {
    key: "node",
    type: "section",
    path: ["node"],
    children: nodes.map((nodeDef) => ({ key: nodeDef.name, type: "node", path: ["node", nodeDef.name], metadata: { nodeDef } })),
  };
}

const PROTOCOLS: ProtocolType[] = ["can", "modbus", "serial"];

/** `meta` first, then `frame` (a section per protocol with frames) and `node`. */
export function catalogToTree(catalog: Catalog): TomlNode[] {
  const tree: TomlNode[] = [{ key: "meta", type: "meta", path: ["meta"] }];
  const sections = PROTOCOLS.flatMap((protocol): TomlNode[] => {
    const frames = catalog.frames.filter((f) => f.protocol === protocol);
    return frames.length === 0 ? [] : [{ key: protocol, type: "section", path: ["frame", protocol], children: frames.map(frameNode) }];
  });
  if (sections.length > 0) tree.push({ key: "frame", type: "section", path: ["frame"], children: sections });
  if (catalog.nodes?.length) tree.push(nodeSection(catalog.nodes));
  return tree;
}
