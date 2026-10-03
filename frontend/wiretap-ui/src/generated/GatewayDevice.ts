// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ActiveCatalogue } from "./ActiveCatalogue";
import type { AssignmentStatus } from "./AssignmentStatus";
import type { CatalogueRef } from "./CatalogueRef";

export type GatewayDevice = { interface: string, assigned: CatalogueRef | null, 
/**
 * `None`: the daemon has not reported what it runs.
 */
active: ActiveCatalogue | null, status: AssignmentStatus, };
