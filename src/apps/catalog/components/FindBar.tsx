// ui/src/apps/catalog/components/FindBar.tsx

import { useEffect, useRef, useCallback } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { disabledState, borderDivider, focusRing, iconButtonHoverSmall } from "../../../styles";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import type { TomlNode } from "../types";

/**
 * Recursively collect all nodes from the tree that match the query.
 * Returns an array of paths.
 */
function findMatchingNodes(nodes: TomlNode[], query: string): string[][] {
  const lowerQuery = query.toLowerCase();
  const matches: string[][] = [];

  function traverse(node: TomlNode) {
    // Check if the node's key matches
    const keyMatches = node.key.toLowerCase().includes(lowerQuery);

    // Check metadata fields that might contain searchable names
    const idMatches = node.metadata?.idValue?.toLowerCase().includes(lowerQuery);
    const transmitterMatches = node.metadata?.transmitter?.toLowerCase().includes(lowerQuery);
    const muxNameMatches = node.metadata?.muxName?.toLowerCase().includes(lowerQuery);

    // For signal nodes, check the value which contains signal properties
    const signalNameMatches = node.type === 'signal' &&
      typeof node.value === 'object' &&
      node.value?.name?.toLowerCase().includes(lowerQuery);

    if (keyMatches || idMatches || transmitterMatches || muxNameMatches || signalNameMatches) {
      matches.push(node.path);
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  for (const node of nodes) {
    traverse(node);
  }

  return matches;
}

/**
 * Get all parent paths for a given path to expand them.
 */
function getParentPaths(path: string[]): string[] {
  const parents: string[] = [];
  for (let i = 1; i < path.length; i++) {
    parents.push(path.slice(0, i).join("."));
  }
  return parents;
}

export default function FindBar() {
  const inputRef = useRef<HTMLInputElement>(null);

  // Store state
  const find = useCatalogEditorStore((s) => s.ui.find);
  const parsedTree = useCatalogEditorStore((s) => s.tree.nodes);
  const expandedIds = useCatalogEditorStore((s) => s.tree.expandedIds);

  // Store actions
  const closeFind = useCatalogEditorStore((s) => s.closeFind);
  const setFindQuery = useCatalogEditorStore((s) => s.setFindQuery);
  const setFindMatches = useCatalogEditorStore((s) => s.setFindMatches);
  const findNext = useCatalogEditorStore((s) => s.findNext);
  const findPrevious = useCatalogEditorStore((s) => s.findPrevious);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);
  const toggleExpanded = useCatalogEditorStore((s) => s.toggleExpanded);

  // Focus input when opened
  useEffect(() => {
    if (find.isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [find.isOpen]);

  // Update matches when query changes
  useEffect(() => {
    if (!find.query.trim()) {
      setFindMatches([]);
      return;
    }

    const matches = findMatchingNodes(parsedTree, find.query.trim());
    setFindMatches(matches);
  }, [find.query, parsedTree, setFindMatches]);

  // Navigate to current match
  const navigateToMatch = useCallback(
    (index: number) => {
      const { matches } = find;
      if (index < 0 || index >= matches.length) return;

      const path = matches[index];
      setSelectedPath(path);

      // Expand all parent nodes
      const parents = getParentPaths(path);
      for (const parentPath of parents) {
        if (!expandedIds.has(parentPath)) {
          toggleExpanded(parentPath);
        }
      }
    },
    [find, setSelectedPath, expandedIds, toggleExpanded]
  );

  // Navigate when currentIndex changes
  useEffect(() => {
    if (find.currentIndex >= 0) {
      navigateToMatch(find.currentIndex);
    }
  }, [find.currentIndex, navigateToMatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeFind();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  };

  if (!find.isOpen) return null;

  const matchCount = find.matches.length;
  const currentMatch = find.currentIndex + 1;

  return (
    <div className={`flex items-center gap-2 px-4 py-2 bg-[var(--bg-surface)] ${borderDivider}`}>
      <input
        ref={inputRef}
        type="text"
        value={find.query}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in catalog..."
        className={`flex-1 px-3 py-1.5 text-sm rounded-md border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRing}`}
      />

      <span className="text-sm text-[color:var(--text-muted)] min-w-[60px] text-center">
        {find.query.trim() ? (matchCount > 0 ? `${currentMatch}/${matchCount}` : "No results") : ""}
      </span>

      <button
        onClick={findPrevious}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className={iconMd} />
      </button>

      <button
        onClick={findNext}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Next match (Enter)"
      >
        <ChevronDown className={iconMd} />
      </button>

      <button
        onClick={closeFind}
        className={iconButtonHoverSmall}
        title="Close (Escape)"
      >
        <X className={iconMd} />
      </button>
    </div>
  );
}
