// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * An id seen on more than one bus.
 */
export type MultiBusFrame = { framesPerBus: { [key in number]: number }, frameId: number, isExtended: boolean, };
