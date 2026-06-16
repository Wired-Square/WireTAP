// ui/src/apps/catalog/components/FindBar.tsx

import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronUp, ChevronDown } from "lucide-react";
import { iconSm } from "../../../styles/spacing";
import { disabledState, focusRing, iconButtonHoverSmall } from "../../../styles";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import type { TomlNode } from "../types";

/** DOM id for the sidebar search input, so the Find menu (⌘F) can focus it. */
export const CATALOG_SEARCH_INPUT_ID = "catalog-tree-search";

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
  const { t } = useTranslation("common");
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

  const matchCount = find.matches.length;
  const currentMatch = find.currentIndex + 1;
  const hasQuery = !!find.query.trim();

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1">
        <Search className={`${iconSm} absolute left-2 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)] pointer-events-none`} />
        <input
          ref={inputRef}
          id={CATALOG_SEARCH_INPUT_ID}
          type="text"
          value={find.query}
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("findBar.placeholderCatalog")}
          className={`w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRing}`}
        />
      </div>

      {hasQuery && (
        <span className="text-xs text-[color:var(--text-muted)] tabular-nums whitespace-nowrap">
          {matchCount > 0
            ? t("findBar.currentOfTotal", { current: currentMatch, total: matchCount })
            : t("findBar.noResults")}
        </span>
      )}

      <button
        onClick={findPrevious}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title={t("findBar.previous")}
      >
        <ChevronUp className={iconSm} />
      </button>

      <button
        onClick={findNext}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title={t("findBar.next")}
      >
        <ChevronDown className={iconSm} />
      </button>
    </div>
  );
}
