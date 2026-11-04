/** A translation tree with every string wrapped in ⟦…⟧. */
export function pseudoTree<T>(value: T): T;
/** The xx-PS files the generator writes, by file name. */
export function generatePseudo(): Record<string, string>;
/** The committed xx-PS files, by file name. */
export function readPseudo(): Record<string, string>;
