// src/hooks/useSelectionSets.ts
//
// Shared hook for loading and auto-refreshing selection sets across panels.
// Subscribes to store:changed events so any mutation (from any panel) is
// reflected in every consumer without manual refresh.

import { useState, useEffect, useCallback } from 'react';
import { getAllSelectionSets, type SelectionSet } from '../utils/selectionSets';
import { onKeyChanged } from '../api/store';

const SELECTION_SETS_KEY = 'selectionSets.all';

export function useSelectionSets() {
  const [selectionSets, setSelectionSets] = useState<SelectionSet[]>([]);

  const loadSelectionSets = useCallback(async () => {
    const all = await getAllSelectionSets();
    all.sort((a, b) => a.name.localeCompare(b.name));
    setSelectionSets(all);
  }, []);

  // Load on mount
  useEffect(() => {
    loadSelectionSets();
  }, [loadSelectionSets]);

  // Auto-refresh when any panel mutates selection sets
  useEffect(() => {
    const promise = onKeyChanged<SelectionSet[]>(SELECTION_SETS_KEY, (value) => {
      const sorted = (value || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      setSelectionSets(sorted);
    });
    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, []);

  return { selectionSets, loadSelectionSets };
}
