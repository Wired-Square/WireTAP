// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Subset of the repository object we act on. Frontend-facing, hence camelCase.
 */
export type RepoInfo = { owner: string, name: string, fullName: string, defaultBranch: string, private: boolean, fork: boolean, 
/**
 * Whether the authenticated user can push — decides fork mode vs direct mode.
 */
canPush: boolean, allowForking: boolean, htmlUrl: string, description?: string, 
/**
 * `parent.full_name` for a fork, so a candidate fork can be confirmed to
 * descend from the upstream we mean.
 */
parentFullName?: string, };
