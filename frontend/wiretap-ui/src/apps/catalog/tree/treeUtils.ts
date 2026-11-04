// ui/src/apps/catalog/tree/treeUtils.ts

import type { TomlNode } from "../types";
import i18n from "../../../i18n";

/** Stable string key for a node based on its TOML path. */
export function nodeKey(node: TomlNode): string {
  return node.path.join(".");
}

/** Find a node anywhere in a tree by TOML path. */
export function findNodeByPath(nodes: TomlNode[], path: string[]): TomlNode | null {
  const want = path.join(".");
  const stack: TomlNode[] = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (nodeKey(n) === want) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

const ROOT_SECTIONS = new Set(["meta", "frame", "node"]);

/** The name a node is shown by: the root tables are named in the UI language, the rest by their key. */
export function nodeLabel(node: TomlNode): string {
  return node.path.length === 1 && ROOT_SECTIONS.has(node.key) ? i18n.t(`catalog:tree.sections.${node.key}`) : node.key;
}

export function treeContainsPath(nodes: TomlNode[], path: string[]): boolean {
  return findNodeByPath(nodes, path) !== null;
}
