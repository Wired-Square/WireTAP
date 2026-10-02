// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { KindTraits } from "./KindTraits";
import type { ProfileTraits } from "./ProfileTraits";

/**
 * Every kind in the order the kind pickers list them, and every profile by id.
 */
export type ProfileTraitsTable = { kinds: Array<KindTraits>, profiles: { [key in string]: ProfileTraits }, };
