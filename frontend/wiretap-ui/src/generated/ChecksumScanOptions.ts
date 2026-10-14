// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Serialisable both ways so a result can echo the settings that produced it —
 * the first thing an agent reading a headless scan wants to know.
 */
export type ChecksumScanOptions = { 
/**
 * Frames an id needs before it is worth analysing.
 */
minSamples?: number, 
/**
 * Checksum offsets to try, end-relative.
 */
positions?: Array<number>, 
/**
 * Recover arbitrary CRC polynomials, not only the named algorithms.
 */
searchCustomPolynomials?: boolean, 
/**
 * How checksum-shaped a byte column must look before the solver is asked
 * about it. Zero solves every column that was not rejected outright.
 */
minLikeness?: number, };
