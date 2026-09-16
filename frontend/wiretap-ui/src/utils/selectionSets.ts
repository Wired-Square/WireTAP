// Selection set persistence using centralised store manager
//
// Uses the Rust-side store manager via IPC for multi-window support.
// No file locking issues since all windows share the same backend store.

import { storeGet, storeSet } from '../api/store';
import { parseFrameKey } from './frameKey';

const SELECTION_SETS_KEY = 'selectionSets.all';

/**
 * A saved selection set of frame IDs with their selection state
 */
export interface SelectionSet {
  /** Unique identifier */
  id: string;
  /** Display name for the selection set */
  name: string;
  /**
   * All frame IDs in this set (visible in picker).
   * Lossy — CAN 0x100 and Modbus register 256 collapse to one 256. Still written so
   * older builds keep reading sets saved by this one; `frameKeys` wins when present.
   */
  frameIds: number[];
  /** Frame IDs that are selected (subset of frameIds) */
  selectedIds: number[];
  /** All frame keys in this set ("can:256"). Authoritative when present. */
  frameKeys?: string[];
  /** Frame keys that are selected (subset of frameKeys) */
  selectedKeys?: string[];
  /** When this selection set was created */
  createdAt: number;
  /** When this selection set was last used */
  lastUsedAt?: number;
}

/**
 * The set's frame keys, falling back to guessing one protocol for every numeric id.
 *
 * Sets saved before frame identity carried protocol hold bare numbers, and a number
 * alone cannot say which protocol it belonged to. The guess is the caller's best
 * context — the capture's protocol, or the catalog's — and is what the old readers
 * did inline. Keeping it in one place means new sets stop guessing entirely.
 */
export function selectionSetKeys(
  set: SelectionSet,
  fallbackProtocol: string
): { all: string[]; selected: string[] } {
  if (set.frameKeys) {
    return { all: set.frameKeys, selected: set.selectedKeys ?? set.frameKeys };
  }
  const key = (id: number) => `${fallbackProtocol}:${id}`;
  return {
    all: set.frameIds.map(key),
    selected: (set.selectedIds ?? set.frameIds).map(key),
  };
}

/** How many frames a set holds, counting identities rather than bare numbers. */
export function selectionSetSize(set: SelectionSet): { total: number; selected: number } {
  return {
    total: set.frameKeys?.length ?? set.frameIds.length,
    selected: set.selectedKeys?.length ?? set.selectedIds?.length ?? set.frameIds.length,
  };
}

/**
 * The legacy numeric arrays for a set of keys, so a build without `frameKeys`
 * support still reads something sensible. Deduplicated, because two protocols
 * sharing a numeric id collapse to one entry here.
 */
function numericFallback(
  frameKeys: string[],
  selectedKeys: string[]
): { frameIds: number[]; selectedIds: number[] } {
  const ids = (keys: string[]) => [...new Set(keys.map((k) => parseFrameKey(k).frameId))];
  return { frameIds: ids(frameKeys), selectedIds: ids(selectedKeys) };
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
  frameKeys: string[],
  selectedKeys: string[]
): Promise<SelectionSet> {
  const sets = await getAllSelectionSets();

  const newSet: SelectionSet = {
    id: generateId(),
    name,
    ...numericFallback(frameKeys, selectedKeys),
    frameKeys: [...frameKeys],
    selectedKeys: [...selectedKeys],
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

  // Keep the legacy numeric arrays in step with the keys rather than making every
  // caller remember to, so a set can never carry the two disagreeing.
  const derived = updates.frameKeys
    ? numericFallback(updates.frameKeys, updates.selectedKeys ?? updates.frameKeys)
    : undefined;
  sets[index] = { ...sets[index], ...derived, ...updates };
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
