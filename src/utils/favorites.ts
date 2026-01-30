// Time range favorites persistence using centralised store manager
//
// Uses the Rust-side store manager via IPC for multi-window support.
// No file locking issues since all windows share the same backend store.

import { storeGet, storeSet } from '../api/store';

const FAVORITES_KEY = 'favorites.timeRanges';

/**
 * A favorite time range bookmark
 */
export interface TimeRangeFavorite {
  /** Unique identifier */
  id: string;
  /** Display name for the favorite */
  name: string;
  /** IO profile ID this favorite is associated with */
  profileId: string;
  /** Start time in ISO-8601 format or datetime-local format */
  startTime: string;
  /** End time in ISO-8601 format or datetime-local format */
  endTime: string;
  /** Maximum number of frames to read (optional) */
  maxFrames?: number;
  /** When this favorite was created */
  createdAt: number;
  /** When this favorite was last used */
  lastUsedAt?: number;
}

/**
 * Generate a unique ID for a new favorite
 */
function generateId(): string {
  return `fav_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get all favorites
 */
export async function getAllFavorites(): Promise<TimeRangeFavorite[]> {
  const favorites = await storeGet<TimeRangeFavorite[]>(FAVORITES_KEY);
  return favorites || [];
}

/**
 * Get favorites for a specific IO profile
 */
export async function getFavoritesForProfile(profileId: string): Promise<TimeRangeFavorite[]> {
  const all = await getAllFavorites();
  return all.filter(f => f.profileId === profileId);
}

/**
 * Add a new favorite
 */
export async function addFavorite(
  name: string,
  profileId: string,
  startTime: string,
  endTime: string
): Promise<TimeRangeFavorite> {
  const favorites = await getAllFavorites();

  const newFavorite: TimeRangeFavorite = {
    id: generateId(),
    name,
    profileId,
    startTime,
    endTime,
    createdAt: Date.now(),
  };

  favorites.push(newFavorite);
  await storeSet(FAVORITES_KEY, favorites);

  return newFavorite;
}

/**
 * Update an existing favorite
 */
export async function updateFavorite(
  id: string,
  updates: Partial<Omit<TimeRangeFavorite, 'id' | 'createdAt'>>
): Promise<TimeRangeFavorite | null> {
  const favorites = await getAllFavorites();

  const index = favorites.findIndex(f => f.id === id);
  if (index === -1) return null;

  favorites[index] = { ...favorites[index], ...updates };
  await storeSet(FAVORITES_KEY, favorites);

  return favorites[index];
}

/**
 * Mark a favorite as recently used
 */
export async function markFavoriteUsed(id: string): Promise<void> {
  await updateFavorite(id, { lastUsedAt: Date.now() });
}

/**
 * Delete a favorite
 */
export async function deleteFavorite(id: string): Promise<boolean> {
  const favorites = await getAllFavorites();

  const index = favorites.findIndex(f => f.id === id);
  if (index === -1) return false;

  favorites.splice(index, 1);
  await storeSet(FAVORITES_KEY, favorites);

  return true;
}

/**
 * Delete all favorites for a specific profile
 */
export async function deleteFavoritesForProfile(profileId: string): Promise<number> {
  const favorites = await getAllFavorites();

  const remaining = favorites.filter(f => f.profileId !== profileId);
  const deletedCount = favorites.length - remaining.length;

  await storeSet(FAVORITES_KEY, remaining);

  return deletedCount;
}
