// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SourceKind } from "./SourceKind";

/**
 * A repository reference plus the optional ref/path the URL narrowed it to.
 */
export type CatalogSource = { host: string, owner: string, repo: string, 
/**
 * Branch, tag or commit sha. `None` means "the repository's default branch",
 * which only the API can tell us.
 */
reference: string | null, 
/**
 * Repo-relative path to a directory or file.
 */
path: string | null, kind: SourceKind, 
/**
 * Set when the ref/path split in a `/tree/…` or `/blob/…` URL was ambiguous
 * because the branch name may itself contain slashes. The caller should
 * confirm `reference` against the API and re-split if it does not resolve.
 */
refIsAmbiguous: boolean, };
