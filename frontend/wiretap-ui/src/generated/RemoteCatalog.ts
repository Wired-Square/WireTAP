// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Metadata for one remote catalogue, resolved by fetching and parsing it.
 */
export type RemoteCatalog = { path: string, blobSha: string, 
/**
 * `[meta].name`, or `None` when the file could not be parsed.
 */
name: string | null, valid: boolean, errors: Array<string>, frameCount: number, 
/**
 * `[meta].version` — the author's revision counter, defaulting to 1 when the key
 * is absent, exactly as the parser reads it. Nothing decodes on this value; it is
 * carried so the push dialog can offer to increment it.
 */
metaVersion: number, 
/**
 * Frames carrying a transmit interval. Surfaced prominently because an imported
 * catalogue can define traffic that would be written to a live bus.
 */
transmitFrameCount: number, protocol?: string, };
