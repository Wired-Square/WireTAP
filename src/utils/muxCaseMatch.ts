// ui/src/utils/muxCaseMatch.ts

/**
 * Mux case key helpers for display.
 *
 * Matching a selector value against a case key is done in Rust
 * (`wiretap_catalog::decode::mux_case_matches`); what remains here is the
 * editor/report side, which only needs to tell a case key from a reserved one
 * and put a set of them in a sensible order.
 */

/**
 * Reserved mux keys that are not case values.
 */
const RESERVED_MUX_KEYS = new Set(["name", "start_bit", "bit_length", "default"]);

/**
 * Check if a string is a valid mux case key (not a reserved key).
 */
export function isMuxCaseKey(key: string): boolean {
  return !RESERVED_MUX_KEYS.has(key);
}

/**
 * Sort mux case keys for display.
 * - Pure numeric keys are sorted numerically
 * - Range keys are sorted by their first value
 * - Mixed keys are sorted lexicographically
 */
export function sortMuxCaseKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    // Extract the first numeric value from each key for comparison
    const aMatch = a.match(/^-?\d+/);
    const bMatch = b.match(/^-?\d+/);

    if (aMatch && bMatch) {
      return parseInt(aMatch[0], 10) - parseInt(bMatch[0], 10);
    }

    // Fall back to lexicographic sort
    return a.localeCompare(b);
  });
}
