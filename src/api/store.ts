// src/api/store.ts
//
// Centralised store API that communicates with the Rust backend.
// Replaces direct tauri-plugin-store usage for multi-window support.
// All windows share the same store via IPC, eliminating file locking issues.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Event payload for store changes
 */
export interface StoreChangedEvent {
  key: string;
}

/**
 * Get a value from the centralised store
 */
export async function storeGet<T>(key: string): Promise<T | null> {
  const result = await invoke<T | null>("store_get", { key });
  return result;
}

/**
 * Set a value in the centralised store.
 * This will broadcast a change event to all windows.
 */
export async function storeSet<T>(key: string, value: T): Promise<void> {
  await invoke("store_set", { key, value });
}

/**
 * Delete a value from the centralised store.
 * Returns true if the key existed and was deleted.
 */
export async function storeDelete(key: string): Promise<boolean> {
  return await invoke<boolean>("store_delete", { key });
}

/**
 * Check if a key exists in the store
 */
export async function storeHas(key: string): Promise<boolean> {
  return await invoke<boolean>("store_has", { key });
}

/**
 * Get all keys in the store
 */
export async function storeKeys(): Promise<string[]> {
  return await invoke<string[]>("store_keys");
}

/**
 * Subscribe to store changes.
 * The callback is called whenever any window modifies the store.
 * Returns an unlisten function to stop receiving updates.
 *
 * @param callback Called with the key that changed
 */
export async function onStoreChanged(
  callback: (event: StoreChangedEvent) => void
): Promise<UnlistenFn> {
  return await listen<StoreChangedEvent>("store:changed", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to changes for a specific key.
 * More efficient than onStoreChanged when you only care about one key.
 *
 * @param key The key to watch
 * @param callback Called when the key changes, with the new value
 */
export async function onKeyChanged<T>(
  key: string,
  callback: (value: T | null) => void
): Promise<UnlistenFn> {
  return await listen<StoreChangedEvent>("store:changed", async (event) => {
    if (event.payload.key === key) {
      const value = await storeGet<T>(key);
      callback(value);
    }
  });
}
