// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A catalogue by its git blob SHA, named by the gateway or else by the local
 * library file with the same bytes.
 */
export type CatalogueRef = { blobSha: string, name: string | null, localFilename: string | null, };
