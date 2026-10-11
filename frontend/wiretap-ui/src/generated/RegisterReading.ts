// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { RegisterPairView } from "./RegisterPairView";
import type { RegisterView } from "./RegisterView";

export type RegisterReading = { register: RegisterView, 
/**
 * With the next address as its low or high word, when the scan found it.
 */
pair: RegisterPairView | null, };
