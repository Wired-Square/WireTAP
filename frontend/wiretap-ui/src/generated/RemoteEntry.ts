// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A candidate catalogue found in a repository, before any content is fetched.
 */
export type RemoteEntry = { path: string, 
/**
 * Basename, which is what the file would be called locally.
 */
filename: string, blobSha: string, size: number, 
/**
 * True when a local catalogue already carries this exact provenance — the UI
 * offers "update" rather than "import" for these.
 */
alreadyTracked: boolean, 
/**
 * True when a local file of the same name exists that we did not import.
 */
nameCollides: boolean, };
