export interface CompiledRule {
  token: string;
  variants: string[];
  selector: string;
  media: string[];
  decls: [string, string][];
  keyframes: string | null;
}

export interface CompiledSource {
  /** The whole sheet. */
  css: string;
  /** Every string that produced a utility: its file (relative to src/) and its tokens. */
  classStrings: { file: string; tokens: string[] }[];
  /** Every source file's text, keyed by path relative to src/. */
  sources: Record<string, string>;
}

/** Compile every class name used under src/; throws when one cannot be compiled. */
export function compileSource(): CompiledSource;
/** One class name → its rule, or null when the token is not a utility. */
export function compile(token: string): CompiledRule | null;
/** Class names WireTAP.css declares itself. */
export function appClasses(): Set<string>;
export function appCss(): string;
/** The committed sheet, or "" before the first generation. */
export function readSheet(): string;
