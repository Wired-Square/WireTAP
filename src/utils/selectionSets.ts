// Selection set persistence using centralised store manager
//
// Uses the Rust-side store manager via IPC for multi-window support.
// No file locking issues since all windows share the same backend store.

import { storeGet, storeSet } from '../api/store';

const SELECTION_SETS_KEY = 'selectionSets.all';

/**
 * A saved selection set of frame IDs with their selection state
 */
export interface SelectionSet {
  /** Unique identifier */
  id: string;
  /** Display name for the selection set */
  name: string;
  /** All frame IDs in this set (visible in picker) */
  frameIds: number[];
  /** Frame IDs that are selected (subset of frameIds) */
  selectedIds: number[];
  /** When this selection set was created */
  createdAt: number;
  /** When this selection set was last used */
  lastUsedAt?: number;
}

/**
 * Generate a unique ID for a new selection set
 */
function generateId(): string {
  return `ss_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get all selection sets
 */
export async function getAllSelectionSets(): Promise<SelectionSet[]> {
  const sets = await storeGet<SelectionSet[]>(SELECTION_SETS_KEY);
  return sets || [];
}

/**
 * Add a new selection set
 */
export async function addSelectionSet(
  name: string,
  frameIds: number[],
  selectedIds: number[]
): Promise<SelectionSet> {
  const sets = await getAllSelectionSets();

  const newSet: SelectionSet = {
    id: generateId(),
    name,
    frameIds: [...frameIds],
    selectedIds: [...selectedIds],
    createdAt: Date.now(),
  };

  sets.push(newSet);
  await storeSet(SELECTION_SETS_KEY, sets);

  return newSet;
}

/**
 * Update an existing selection set
 */
export async function updateSelectionSet(
  id: string,
  updates: Partial<Omit<SelectionSet, 'id' | 'createdAt'>>
): Promise<SelectionSet | null> {
  const sets = await getAllSelectionSets();

  const index = sets.findIndex(s => s.id === id);
  if (index === -1) return null;

  sets[index] = { ...sets[index], ...updates };
  await storeSet(SELECTION_SETS_KEY, sets);

  return sets[index];
}

/**
 * Mark a selection set as recently used
 */
export async function markSelectionSetUsed(id: string): Promise<void> {
  await updateSelectionSet(id, { lastUsedAt: Date.now() });
}

/**
 * Delete a selection set
 */
export async function deleteSelectionSet(id: string): Promise<boolean> {
  const sets = await getAllSelectionSets();

  const index = sets.findIndex(s => s.id === id);
  if (index === -1) return false;

  sets.splice(index, 1);
  await storeSet(SELECTION_SETS_KEY, sets);

  return true;
}

/**
 * Clear all selection sets
 */
export async function clearAllSelectionSets(): Promise<void> {
  await storeSet(SELECTION_SETS_KEY, []);
}
