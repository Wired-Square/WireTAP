// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { LocalState } from "./LocalState";

/**
 * The remote text for one tracked catalogue, alongside the local copy.
 */
export type RemoteCatalogText = { catalogId: string, localFilename: string, repoLabel: string, 
/**
 * Upstream content.
 */
remoteToml: string, remoteBlobSha: string, 
/**
 * The local file as it is on disk right now.
 */
localToml: string, 
/**
 * Git blob SHA-1 of the local file, echoed back on apply so the backend can
 * refuse to overwrite a file that changed while it was being reviewed.
 */
localSha?: string, localState: LocalState, 
/**
 * Empty when the upstream file is a valid catalogue; applying is blocked otherwise.
 */
validationErrors: Array<string>, 
/**
 * Transmit-interval frames the update would introduce, for the same reason
 * import surfaces them: a catalogue can define traffic that reaches a live bus.
 */
transmitFrameCount: number, };
