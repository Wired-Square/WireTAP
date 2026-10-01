// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CollisionPolicy } from "./CollisionPolicy";

export type ImportRequest = { 
/**
 * The URL as pasted; re-parsed here so the frontend cannot smuggle in a
 * different repository than the one it browsed.
 */
input: string, gitRef: string, paths: Array<string>, onCollision?: CollisionPolicy, };
