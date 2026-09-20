#!/usr/bin/env node
// Generates src/styles/utilities.css: the app's own utility sheet, keeping Tailwind's
// class names so no component changes. Every string literal under src/ is scanned for
// class names, each is compiled through the family table below, and the rules are
// sorted the way Tailwind 4 sorts them. Values are resolved — none of Tailwind's theme
// variables — except the ring/shadow, translate and gradient variables, which compose
// across classes on one element (see the Tailwind Removal Feasibility note, Phase 1), and
// the app's own theme colours, which are utilities by name (THEME below).
//
//   npm run gen:css        rewrite the sheet
//
// Grammar: [!]?(variant:)*[-]?family-value[/alpha], or [property:value].
// An unknown family is ignored, as Tailwind does. A known family with a value it cannot
// resolve, or a utility under a variant the table below lacks (dark:, md:, [&…]:, …),
// fails the run, so a typo in a class name is a build error rather than a silently
// missing rule.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(PACKAGE_ROOT, "src");
const SHEET_PATH = path.join(SRC_DIR, "styles", "utilities.css");

// ---------------------------------------------------------------------------------------
// Theme values, from tailwindcss/theme.css (4.3.0). Colours are the app's own (THEME below)
// plus these named ones; there is no palette and no `[#hex]`, so `text-red-500` is a build
// error and a colour the theme lacks is a variable to add, not a class to spell.
// ---------------------------------------------------------------------------------------

const NAMED_COLOURS = { white: "#fff", black: "#000", transparent: "transparent", current: "currentcolor", inherit: "inherit" };

// Theme colours: every variable WireTAP.css declares, by name. The class value is the
// variable minus `--` and `status-`, and minus the family's own role where the name carries
// one, so `--text-muted` is `text-muted` and `bg-text-muted`, `--status-info-text` is
// `text-info` and `bg-info-text`, `--bg-surface` is `bg-surface` and `border-bg-surface`.
const THEME_VARIABLES = [...new Set(
  [...fs.readFileSync(path.join(SRC_DIR, "WireTAP.css"), "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
)].filter((v) => !/^--(font|radius)-/.test(v));

function themeColours(role) {
  const table = {};
  for (const variable of THEME_VARIABLES) {
    const parts = variable.slice(2).replace(/^status-/, "").split("-");
    const i = parts.indexOf(role);
    if (i >= 0) parts.splice(i, 1);
    const name = parts.join("-");
    if (table[name]) throw new Error(`gen-utilities: ${variable} and ${table[name]} would both be ${role}-${name}`);
    table[name] = variable;
  }
  return table;
}
const THEME = { text: themeColours("text"), bg: themeColours("bg"), border: themeColours("border") };

const SPACING_REM = 0.25;
const CONTAINERS = { "3xs": "16rem", "2xs": "18rem", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem" };
const TEXT_SIZES = {
  "2xs": ["0.625rem", "calc(0.875 / 0.625)"], xs: ["0.75rem", "calc(1 / 0.75)"], sm: ["0.875rem", "calc(1.25 / 0.875)"], base: ["1rem", "calc(1.5 / 1)"],
  lg: ["1.125rem", "calc(1.75 / 1.125)"], xl: ["1.25rem", "calc(1.75 / 1.25)"], "2xl": ["1.5rem", "calc(2 / 1.5)"],
  "3xl": ["1.875rem", "calc(2.25 / 1.875)"], "4xl": ["2.25rem", "calc(2.5 / 2.25)"], "5xl": ["3rem", "1"],
  "6xl": ["3.75rem", "1"], "7xl": ["4.5rem", "1"], "8xl": ["6rem", "1"], "9xl": ["8rem", "1"],
};
const FONT_WEIGHTS = { thin: "100", extralight: "200", light: "300", normal: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900" };
const FONT_FAMILIES = {
  sans: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: "var(--font-mono)",
};
const TRACKING = { tighter: "-0.05em", tight: "-0.025em", normal: "0em", wide: "0.025em", wider: "0.05em", widest: "0.1em" };
const LEADING = { tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2" };
const RADII = { none: "0", xs: "0.125rem", sm: "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", "4xl": "2rem", full: "calc(infinity * 1px)" };
const SHADOWS = {
  "2xs": "0 1px rgb(0 0 0 / 0.05)",
  xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
};
const BLURS = { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "40px", "3xl": "64px" };
const EASES = { linear: "linear", in: "cubic-bezier(0.4, 0, 1, 1)", out: "cubic-bezier(0, 0, 0.2, 1)", "in-out": "cubic-bezier(0.4, 0, 0.2, 1)" };
const DEFAULT_TRANSITION = ["transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)", "transition-duration", "150ms"];
const ANIMATIONS = {
  spin: ["spin 1s linear infinite", "@keyframes spin { to { transform: rotate(360deg) } }"],
  ping: ["ping 1s cubic-bezier(0, 0, 0.2, 1) infinite", "@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0 } }"],
  pulse: ["pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite", "@keyframes pulse { 50% { opacity: 0.5 } }"],
  bounce: ["bounce 1s infinite", "@keyframes bounce { 0%, 100% { transform: translateY(-25%); animation-timing-function: cubic-bezier(0.8, 0, 1, 1) } 50% { transform: none; animation-timing-function: cubic-bezier(0, 0, 0.2, 1) } }"],
};

const TRANSITION_COLOURS = "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke";
const TRANSITION_PROPERTIES = {
  "": `${TRANSITION_COLOURS}, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events`,
  all: "all",
  colors: TRANSITION_COLOURS,
  opacity: "opacity",
  shadow: "box-shadow",
  transform: "transform, translate, scale, rotate",
};

// The composition variables the sheet keeps. reset.css defaults them on
// `*, ::before, ::after`, mirroring Tailwind's non-@property fallback.
const BOX_SHADOW = "var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)";
const TRANSLATE = "var(--tw-translate-x) var(--tw-translate-y)";

// ---------------------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------------------

const isNumber = (v) => /^\d+(\.\d+)?$/.test(v);
const isInteger = (v) => /^\d+$/.test(v);
const isArbitrary = (v) => v.startsWith("[") && v.endsWith("]") && v.length > 2;
const isLengthLike = (v) => /^-?\d*\.?\d+(px|rem|em|vh|vw|vmin|vmax|%|ch|ex|svh|lvh|dvh)?$/.test(v) || /^calc\(/.test(v);

function formatNumber(n) {
  return String(parseFloat(n.toFixed(6)));
}

function spacing(n, negative = false) {
  const rem = parseFloat(n) * SPACING_REM;
  return rem === 0 ? "0" : `${formatNumber(negative ? -rem : rem)}rem`;
}

/** `[color:var(--x)]` → { hint: "color", value: "var(--x)" }; `_` is a space unless escaped. */
function arbitrary(v) {
  let inner = v.slice(1, -1);
  let hint = null;
  const m = /^([a-z-]+):/.exec(inner);
  if (m && ["color", "length", "number", "percentage", "url", "image"].includes(m[1])) {
    hint = m[1];
    inner = inner.slice(m[0].length);
  }
  return { hint, value: inner.replace(/(?<!\\)_/g, " ").replace(/\\_/g, "_") };
}

/** `1/2` → `50%`; a repeating fraction stays a calc(), as Tailwind writes it. */
function fraction(v, negative = false) {
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (!m) return null;
  const percent = (Number(m[1]) / Number(m[2])) * 100;
  const sign = negative ? "-" : "";
  return Number.isInteger(percent * 1000) ? `${sign}${formatNumber(percent)}%` : `calc(${m[1]}/${m[2]} * ${sign}100%)`;
}

/**
 * The spacing scale as Tailwind resolves it for margin, padding, sizing, gap and inset:
 * bare numbers, px, full, auto, fractions where the utility allows them, arbitrary values.
 */
function spacingValue(v, { negative = false, fractions = false, extra = {} } = {}) {
  if (v in extra) return extra[v];
  if (isNumber(v)) return spacing(v, negative);
  if (v === "px") return negative ? "-1px" : "1px";
  if (fractions) {
    const f = fraction(v, negative);
    if (f) return f;
  }
  if (isArbitrary(v)) return negative ? `calc(${arbitrary(v).value} * -1)` : arbitrary(v).value;
  return null;
}

/** Palette-shade, named, a theme colour of the family's role, or arbitrary, each with an optional /alpha. */
function colour(v, role = null) {
  const slash = v.lastIndexOf("/");
  let base = v;
  let alpha = null;
  if (slash > 0 && !v.slice(slash).includes("]")) {
    base = v.slice(0, slash);
    alpha = v.slice(slash + 1);
    if (!isNumber(alpha)) return null;
  }
  const resolved = base in NAMED_COLOURS ? NAMED_COLOURS[base] : role && base in THEME[role] ? `var(${THEME[role][base]})` : null;
  if (resolved === null) return null;
  return alpha === null ? resolved : `color-mix(in oklab, ${resolved} ${alpha}%, transparent)`;
}

// ---------------------------------------------------------------------------------------
// Family table. Each entry compiles a value to declarations ([property, value] pairs) or
// returns null for a value it does not recognise. `tw` carries Tailwind's own declaration
// list where the owned form's declarations would sort differently (see propertySort).
// ---------------------------------------------------------------------------------------

const decl = (...pairs) => {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]);
  return out;
};
const rule = (decls, extra = {}) => ({ decls, ...extra });
/** A property Tailwind routes through a `--tw-*` variable, which is what it sorts by. */
const viaVariable = (variable, prop, value) => rule(decl(prop, value), { tw: [variable, prop] });

const STATIC = {
  "pointer-events-none": decl("pointer-events", "none"),
  "pointer-events-auto": decl("pointer-events", "auto"),
  visible: decl("visibility", "visible"),
  invisible: decl("visibility", "hidden"),
  collapse: decl("visibility", "collapse"),
  static: decl("position", "static"),
  fixed: decl("position", "fixed"),
  absolute: decl("position", "absolute"),
  relative: decl("position", "relative"),
  sticky: decl("position", "sticky"),
  isolate: decl("isolation", "isolate"),
  "box-border": decl("box-sizing", "border-box"),
  "box-content": decl("box-sizing", "content-box"),
  block: decl("display", "block"),
  "inline-block": decl("display", "inline-block"),
  inline: decl("display", "inline"),
  flex: decl("display", "flex"),
  "inline-flex": decl("display", "inline-flex"),
  table: decl("display", "table"),
  "inline-table": decl("display", "inline-table"),
  "table-cell": decl("display", "table-cell"),
  "table-row": decl("display", "table-row"),
  grid: decl("display", "grid"),
  "inline-grid": decl("display", "inline-grid"),
  contents: decl("display", "contents"),
  hidden: decl("display", "none"),
  "aspect-square": decl("aspect-ratio", "1"),
  "aspect-video": decl("aspect-ratio", "16 / 9"),
  "aspect-auto": decl("aspect-ratio", "auto"),
  "flex-auto": decl("flex", "1 1 auto"),
  "flex-initial": decl("flex", "0 1 auto"),
  "flex-none": decl("flex", "none"),
  "flex-shrink": decl("flex-shrink", "1"),
  "flex-shrink-0": decl("flex-shrink", "0"),
  shrink: decl("flex-shrink", "1"),
  "shrink-0": decl("flex-shrink", "0"),
  "flex-grow": decl("flex-grow", "1"),
  "flex-grow-0": decl("flex-grow", "0"),
  grow: decl("flex-grow", "1"),
  "grow-0": decl("flex-grow", "0"),
  "table-auto": decl("table-layout", "auto"),
  "table-fixed": decl("table-layout", "fixed"),
  "border-collapse": decl("border-collapse", "collapse"),
  "border-separate": decl("border-collapse", "separate"),
  "transform-none": decl("transform", "none"),
  "cursor-auto": decl("cursor", "auto"),
  "cursor-default": decl("cursor", "default"),
  "cursor-pointer": decl("cursor", "pointer"),
  "cursor-wait": decl("cursor", "wait"),
  "cursor-text": decl("cursor", "text"),
  "cursor-move": decl("cursor", "move"),
  "cursor-help": decl("cursor", "help"),
  "cursor-not-allowed": decl("cursor", "not-allowed"),
  "cursor-none": decl("cursor", "none"),
  "cursor-progress": decl("cursor", "progress"),
  "cursor-cell": decl("cursor", "cell"),
  "cursor-crosshair": decl("cursor", "crosshair"),
  "cursor-grab": decl("cursor", "grab"),
  "cursor-grabbing": decl("cursor", "grabbing"),
  "cursor-col-resize": decl("cursor", "col-resize"),
  "cursor-row-resize": decl("cursor", "row-resize"),
  "cursor-ns-resize": decl("cursor", "ns-resize"),
  "cursor-ew-resize": decl("cursor", "ew-resize"),
  "cursor-zoom-in": decl("cursor", "zoom-in"),
  "cursor-zoom-out": decl("cursor", "zoom-out"),
  resize: decl("resize", "both"),
  "resize-none": decl("resize", "none"),
  "resize-x": decl("resize", "horizontal"),
  "resize-y": decl("resize", "vertical"),
  "list-inside": decl("list-style-position", "inside"),
  "list-outside": decl("list-style-position", "outside"),
  "list-none": decl("list-style-type", "none"),
  "list-disc": decl("list-style-type", "disc"),
  "list-decimal": decl("list-style-type", "decimal"),
  "appearance-none": decl("appearance", "none"),
  "grid-cols-none": decl("grid-template-columns", "none"),
  "grid-rows-none": decl("grid-template-rows", "none"),
  "flex-row": decl("flex-direction", "row"),
  "flex-row-reverse": decl("flex-direction", "row-reverse"),
  "flex-col": decl("flex-direction", "column"),
  "flex-col-reverse": decl("flex-direction", "column-reverse"),
  "flex-wrap": decl("flex-wrap", "wrap"),
  "flex-wrap-reverse": decl("flex-wrap", "wrap-reverse"),
  "flex-nowrap": decl("flex-wrap", "nowrap"),
  "place-items-center": decl("place-items", "center"),
  "content-center": decl("align-content", "center"),
  "content-start": decl("align-content", "flex-start"),
  "content-end": decl("align-content", "flex-end"),
  "content-between": decl("align-content", "space-between"),
  "items-start": decl("align-items", "flex-start"),
  "items-end": decl("align-items", "flex-end"),
  "items-center": decl("align-items", "center"),
  "items-baseline": decl("align-items", "baseline"),
  "items-stretch": decl("align-items", "stretch"),
  "justify-start": decl("justify-content", "flex-start"),
  "justify-end": decl("justify-content", "flex-end"),
  "justify-center": decl("justify-content", "center"),
  "justify-between": decl("justify-content", "space-between"),
  "justify-around": decl("justify-content", "space-around"),
  "justify-evenly": decl("justify-content", "space-evenly"),
  "justify-stretch": decl("justify-content", "stretch"),
  "justify-items-center": decl("justify-items", "center"),
  "self-auto": decl("align-self", "auto"),
  "self-start": decl("align-self", "flex-start"),
  "self-end": decl("align-self", "flex-end"),
  "self-center": decl("align-self", "center"),
  "self-stretch": decl("align-self", "stretch"),
  "self-baseline": decl("align-self", "baseline"),
  "justify-self-end": decl("justify-self", "flex-end"),
  "overflow-auto": decl("overflow", "auto"),
  "overflow-hidden": decl("overflow", "hidden"),
  "overflow-clip": decl("overflow", "clip"),
  "overflow-visible": decl("overflow", "visible"),
  "overflow-scroll": decl("overflow", "scroll"),
  "overflow-x-auto": decl("overflow-x", "auto"),
  "overflow-x-hidden": decl("overflow-x", "hidden"),
  "overflow-x-scroll": decl("overflow-x", "scroll"),
  "overflow-y-auto": decl("overflow-y", "auto"),
  "overflow-y-hidden": decl("overflow-y", "hidden"),
  "overflow-y-scroll": decl("overflow-y", "scroll"),
  "overscroll-auto": decl("overscroll-behavior", "auto"),
  "overscroll-contain": decl("overscroll-behavior", "contain"),
  "overscroll-none": decl("overscroll-behavior", "none"),
  "scroll-smooth": decl("scroll-behavior", "smooth"),
  "border-solid": viaVariable("--tw-border-style", "border-style", "solid"),
  "border-dashed": viaVariable("--tw-border-style", "border-style", "dashed"),
  "border-dotted": viaVariable("--tw-border-style", "border-style", "dotted"),
  "border-double": viaVariable("--tw-border-style", "border-style", "double"),
  "border-none": viaVariable("--tw-border-style", "border-style", "none"),
  "bg-none": decl("background-image", "none"),
  "bg-cover": decl("background-size", "cover"),
  "bg-contain": decl("background-size", "contain"),
  "bg-center": decl("background-position", "center"),
  "bg-no-repeat": decl("background-repeat", "no-repeat"),
  "object-contain": decl("object-fit", "contain"),
  "object-cover": decl("object-fit", "cover"),
  "object-fill": decl("object-fit", "fill"),
  "object-none": decl("object-fit", "none"),
  "object-scale-down": decl("object-fit", "scale-down"),
  "object-center": decl("object-position", "center"),
  "text-left": decl("text-align", "left"),
  "text-center": decl("text-align", "center"),
  "text-right": decl("text-align", "right"),
  "text-justify": decl("text-align", "justify"),
  "align-baseline": decl("vertical-align", "baseline"),
  "align-top": decl("vertical-align", "top"),
  "align-middle": decl("vertical-align", "middle"),
  "align-bottom": decl("vertical-align", "bottom"),
  "align-text-top": decl("vertical-align", "text-top"),
  "align-text-bottom": decl("vertical-align", "text-bottom"),
  "text-wrap": decl("text-wrap", "wrap"),
  "text-nowrap": decl("text-wrap", "nowrap"),
  "text-balance": decl("text-wrap", "balance"),
  "text-pretty": decl("text-wrap", "pretty"),
  "break-normal": decl("overflow-wrap", "normal", "word-break", "normal"),
  "break-words": decl("overflow-wrap", "break-word"),
  "break-all": decl("word-break", "break-all"),
  "break-keep": decl("word-break", "keep-all"),
  truncate: decl("overflow", "hidden", "text-overflow", "ellipsis", "white-space", "nowrap"),
  "text-ellipsis": decl("text-overflow", "ellipsis"),
  "text-clip": decl("text-overflow", "clip"),
  "whitespace-normal": decl("white-space", "normal"),
  "whitespace-nowrap": decl("white-space", "nowrap"),
  "whitespace-pre": decl("white-space", "pre"),
  "whitespace-pre-line": decl("white-space", "pre-line"),
  "whitespace-pre-wrap": decl("white-space", "pre-wrap"),
  "whitespace-break-spaces": decl("white-space", "break-spaces"),
  uppercase: decl("text-transform", "uppercase"),
  lowercase: decl("text-transform", "lowercase"),
  capitalize: decl("text-transform", "capitalize"),
  "normal-case": decl("text-transform", "none"),
  italic: decl("font-style", "italic"),
  "not-italic": decl("font-style", "normal"),
  "normal-nums": decl("font-variant-numeric", "normal"),
  ordinal: viaVariable("--tw-ordinal", "font-variant-numeric", "ordinal"),
  "slashed-zero": viaVariable("--tw-slashed-zero", "font-variant-numeric", "slashed-zero"),
  "lining-nums": viaVariable("--tw-numeric-figure", "font-variant-numeric", "lining-nums"),
  "oldstyle-nums": viaVariable("--tw-numeric-figure", "font-variant-numeric", "oldstyle-nums"),
  "proportional-nums": viaVariable("--tw-numeric-spacing", "font-variant-numeric", "proportional-nums"),
  "tabular-nums": viaVariable("--tw-numeric-spacing", "font-variant-numeric", "tabular-nums"),
  underline: decl("text-decoration-line", "underline"),
  overline: decl("text-decoration-line", "overline"),
  "line-through": decl("text-decoration-line", "line-through"),
  "no-underline": decl("text-decoration-line", "none"),
  "decoration-solid": decl("text-decoration-style", "solid"),
  "decoration-double": decl("text-decoration-style", "double"),
  "decoration-dotted": decl("text-decoration-style", "dotted"),
  "decoration-dashed": decl("text-decoration-style", "dashed"),
  "decoration-wavy": decl("text-decoration-style", "wavy"),
  "accent-auto": decl("accent-color", "auto"),
  "shadow-none": decl("--tw-shadow", "0 0 #0000", "box-shadow", BOX_SHADOW),
  "ring-inset": decl("--tw-ring-inset", "inset"),
  outline: decl("outline-style", "solid", "outline-width", "1px"),
  "outline-none": viaVariable("--tw-outline-style", "outline-style", "none"),
  "outline-dashed": viaVariable("--tw-outline-style", "outline-style", "dashed"),
  "outline-dotted": viaVariable("--tw-outline-style", "outline-style", "dotted"),
  blur: filterRule("--tw-blur", "blur(8px)"),
  "blur-none": filterRule("--tw-blur", "none"),
  invert: filterRule("--tw-invert", "invert(100%)"),
  "invert-0": filterRule("--tw-invert", "invert(0%)"),
  grayscale: filterRule("--tw-grayscale", "grayscale(100%)"),
  "grayscale-0": filterRule("--tw-grayscale", "grayscale(0%)"),
  sepia: filterRule("--tw-sepia", "sepia(100%)"),
  "sepia-0": filterRule("--tw-sepia", "sepia(0%)"),
  "transition-none": decl("transition-property", "none"),
  "select-none": decl("-webkit-user-select", "none", "user-select", "none"),
  "select-text": decl("-webkit-user-select", "text", "user-select", "text"),
  "select-all": decl("-webkit-user-select", "all", "user-select", "all"),
  "select-auto": decl("-webkit-user-select", "auto", "user-select", "auto"),
  // `transform` and `filter` bare only assemble the --tw-* variables that our plain
  // properties no longer use, so they compile to nothing.
  transform: rule([]),
  filter: rule([]),
};

function filterRule(variable, fn) {
  return viaVariable(variable, "filter", fn);
}

function sizeValue(v, extra = {}) {
  return spacingValue(v, { fractions: true, extra: { auto: "auto", full: "100%", screen: "100vh", min: "min-content", max: "max-content", fit: "fit-content", ...extra } });
}

const BORDER_SIDES = { "": "border", x: "border-inline", y: "border-block", t: "border-top", r: "border-right", b: "border-bottom", l: "border-left" };

/** `border`, `border-2`, `border-t-0`, `border-red-500`, `border-t-transparent`. */
function border(side, v) {
  const prefix = BORDER_SIDES[side];
  const width = v === "" ? "1px" : isInteger(v) ? `${v}px` : isArbitrary(v) && arbitrary(v).hint !== "color" && isLengthLike(arbitrary(v).value) ? arbitrary(v).value : null;
  if (width !== null) return decl(`${prefix}-style`, "solid", `${prefix}-width`, width);
  const c = colour(v, "border");
  return c ? decl(`${prefix}-color`, c) : null;
}

const corners = {
  "": ["border-radius"],
  t: ["border-top-left-radius", "border-top-right-radius"],
  r: ["border-top-right-radius", "border-bottom-right-radius"],
  b: ["border-bottom-right-radius", "border-bottom-left-radius"],
  l: ["border-top-left-radius", "border-bottom-left-radius"],
  tl: ["border-top-left-radius"],
  tr: ["border-top-right-radius"],
  br: ["border-bottom-right-radius"],
  bl: ["border-bottom-left-radius"],
};

/** `root`, `root-t`, `root-tl`, … → one family per key of `sides`. */
const perSide = (root, sides, fn) => Object.fromEntries(Object.keys(sides).map((s) => [s ? `${root}-${s}` : root, (v) => fn(s, v)]));

function rounded(corner, v) {
  const radius = v === "" ? "0.25rem" : v in RADII ? RADII[v] : isArbitrary(v) ? arbitrary(v).value : null;
  return radius === null ? null : corners[corner].map((p) => [p, radius]);
}

function ringWidth(v) {
  const width = v === "" ? "1px" : isInteger(v) ? `${v}px` : null;
  if (width === null) return null;
  return decl("--tw-ring-shadow", `var(--tw-ring-inset,) 0 0 0 calc(${width} + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor)`, "box-shadow", BOX_SHADOW);
}

function shadow(v) {
  const size = v === "" ? SHADOWS.sm : SHADOWS[v];
  if (size) {
    const withColour = size.replace(/rgb\([^)]*\)/g, (c) => `var(--tw-shadow-color, ${c})`);
    return decl("--tw-shadow", withColour, "box-shadow", BOX_SHADOW);
  }
  const c = colour(v, "bg");
  return c ? decl("--tw-shadow-color", c) : null;
}

function spaceBetween(axis, v) {
  const gap = spacingValue(v);
  if (gap === null) return null;
  const margin = axis === "y" ? "margin-block-end" : "margin-inline-end";
  // Tailwind sorts space-y as column-gap and space-x as row-gap (sic).
  return rule(decl(margin, gap), {
    children: true,
    tw: [`--tw-sort:${axis === "y" ? "column-gap" : "row-gap"}`, `--tw-space-${axis}-reverse`, `margin-${axis === "y" ? "block" : "inline"}-start`, margin],
  });
}

function divide(v) {
  if (v === "y" || v === "x" || /^[xy]-\d+$/.test(v)) {
    const axis = v[0];
    const width = v.length === 1 ? "1px" : `${v.slice(2)}px`;
    const [start, end] = axis === "y" ? ["top", "bottom"] : ["left", "right"];
    return rule(decl(`border-${start}-style`, "solid", `border-${end}-style`, "solid", `border-${start}-width`, "0", `border-${end}-width`, width), {
      children: true,
      tw: [`--tw-sort:divide-${axis}-width`, `--tw-divide-${axis}-reverse`, `border-${end}-style`, `border-${start}-style`, `border-${start}-width`, `border-${end}-width`],
    });
  }
  const c = colour(v, "border");
  return c ? rule(decl("border-color", c), { children: true, tw: ["--tw-sort:divide-color", "border-color"] }) : null;
}

function text(v) {
  if (v in TEXT_SIZES) return decl("font-size", TEXT_SIZES[v][0], "line-height", TEXT_SIZES[v][1]);
  if (isArbitrary(v)) {
    const { hint, value } = arbitrary(v);
    if (hint === "length" || (hint === null && isLengthLike(value))) return decl("font-size", value);
  }
  const c = colour(v, "text");
  return c ? decl("color", c) : null;
}

function font(v) {
  if (v in FONT_WEIGHTS) return viaVariable("--tw-font-weight", "font-weight", FONT_WEIGHTS[v]);
  if (v in FONT_FAMILIES) return decl("font-family", FONT_FAMILIES[v]);
  return null;
}

function background(v) {
  const m = /^gradient-to-([trbl]{1,2})$/.exec(v);
  if (m) {
    const dir = { t: "top", r: "right", b: "bottom", l: "left", tr: "top right", tl: "top left", br: "bottom right", bl: "bottom left" }[m[1]];
    return rule(decl("background-image", `linear-gradient(to ${dir} in oklab, var(--tw-gradient-from) 0%, var(--tw-gradient-to) 100%)`), {
      tw: ["--tw-gradient-position", "background-image"],
    });
  }
  const c = colour(v, "bg");
  return c ? decl("background-color", c) : null;
}

function gradientStop(stop, v) {
  const c = colour(v, "bg");
  return c ? rule(decl(`--tw-gradient-${stop}`, c), { tw: ["--tw-gradient-stops", `--tw-gradient-${stop}`] }) : null;
}

function translate(axis, v, negative) {
  const t = spacingValue(v, { negative, fractions: true, extra: { full: negative ? "-100%" : "100%" } });
  return t === null ? null : decl(`--tw-translate-${axis}`, t, "translate", TRANSLATE);
}

function transition(v) {
  const property = v in TRANSITION_PROPERTIES ? TRANSITION_PROPERTIES[v] : isArbitrary(v) ? arbitrary(v).value : null;
  return property === null ? null : decl("transition-property", property, ...DEFAULT_TRANSITION);
}

function gridTemplate(axis, v) {
  if (isInteger(v)) return decl(`grid-template-${axis}`, `repeat(${v}, minmax(0, 1fr))`);
  if (v === "subgrid") return decl(`grid-template-${axis}`, "subgrid");
  return isArbitrary(v) ? decl(`grid-template-${axis}`, arbitrary(v).value) : null;
}

/** A one-declaration family: `resolve` returns the value or null. */
const one = (prop, resolve) => (v, negative) => {
  const value = resolve(v, negative);
  return value == null ? null : decl(prop, value);
};

const insetValue = (v, n) => spacingValue(v, { negative: n, fractions: true, extra: { auto: "auto", full: n ? "-100%" : "100%" } });
const marginValue = (v, n) => spacingValue(v, { negative: n, extra: { auto: "auto" } });
const heightValue = (extra = {}) => (v) => sizeValue(v, { lh: "1lh", svh: "100svh", dvh: "100dvh", ...extra });
const widthValue = (extra = {}) => (v) => sizeValue(v, { screen: "100vw", svw: "100svw", dvw: "100dvw", ...CONTAINERS, ...extra });
const plainSpacing = (v) => spacingValue(v);
const arbitraryOnly = (v) => (isArbitrary(v) ? arbitrary(v).value : null);
const span = (v) => (isInteger(v) ? `span ${v} / span ${v}` : v === "full" ? "1 / -1" : null);
const filterFamily = (variable, fn) => (v) => (isNumber(v) ? filterRule(variable, `${fn}(${v}%)`) : null);
const textColour = (v) => colour(v, "text");
const borderColour = (v) => colour(v, "border");

const FUNCTIONAL = {
  inset: one("inset", insetValue),
  "inset-x": one("inset-inline", insetValue),
  "inset-y": one("inset-block", insetValue),
  top: one("top", insetValue),
  right: one("right", insetValue),
  bottom: one("bottom", insetValue),
  left: one("left", insetValue),
  z: one("z-index", (v, n) => (isInteger(v) ? `${n ? "-" : ""}${v}` : v === "auto" ? "auto" : arbitraryOnly(v))),
  "col-span": one("grid-column", span),
  "row-span": one("grid-row", span),
  m: one("margin", marginValue),
  mx: one("margin-inline", marginValue),
  my: one("margin-block", marginValue),
  ms: one("margin-inline-start", marginValue),
  me: one("margin-inline-end", marginValue),
  mt: one("margin-top", marginValue),
  mr: one("margin-right", marginValue),
  mb: one("margin-bottom", marginValue),
  ml: one("margin-left", marginValue),
  "line-clamp": (v) => (isInteger(v) ? decl("overflow", "hidden", "display", "-webkit-box", "-webkit-box-orient", "vertical", "-webkit-line-clamp", v) : null),
  h: one("height", heightValue()),
  "min-h": one("min-height", heightValue()),
  "max-h": one("max-height", heightValue({ none: "none" })),
  w: one("width", widthValue()),
  "min-w": one("min-width", widthValue()),
  "max-w": one("max-width", widthValue({ none: "none" })),
  flex: one("flex", (v) => (isInteger(v) ? v : arbitraryOnly(v))),
  "translate-x": (v, n) => translate("x", v, n),
  "translate-y": (v, n) => translate("y", v, n),
  scale: (v) => (isNumber(v) ? rule(decl("scale", `${v}% ${v}%`), { tw: ["--tw-scale-x", "--tw-scale-y", "--tw-scale-z", "scale"] }) : null),
  rotate: one("rotate", (v, n) => (isNumber(v) ? `${n ? "-" : ""}${v}deg` : arbitraryOnly(v))),
  animate: (v) => (v === "none" ? decl("animation", "none") : ANIMATIONS[v] ? rule(decl("animation", ANIMATIONS[v][0]), { keyframes: ANIMATIONS[v][1] }) : null),
  "grid-cols": (v) => gridTemplate("columns", v),
  "grid-rows": (v) => gridTemplate("rows", v),
  gap: one("gap", plainSpacing),
  "gap-x": one("column-gap", plainSpacing),
  "gap-y": one("row-gap", plainSpacing),
  "space-x": (v) => spaceBetween("x", v),
  "space-y": (v) => spaceBetween("y", v),
  divide,
  ...perSide("rounded", corners, rounded),
  ...perSide("border", BORDER_SIDES, border),
  bg: background,
  from: (v) => gradientStop("from", v),
  to: (v) => gradientStop("to", v),
  fill: one("fill", textColour),
  stroke: one("stroke", textColour),
  p: one("padding", plainSpacing),
  px: one("padding-inline", plainSpacing),
  py: one("padding-block", plainSpacing),
  ps: one("padding-inline-start", plainSpacing),
  pe: one("padding-inline-end", plainSpacing),
  pt: one("padding-top", plainSpacing),
  pr: one("padding-right", plainSpacing),
  pb: one("padding-bottom", plainSpacing),
  pl: one("padding-left", plainSpacing),
  text,
  font,
  leading: (v) => {
    const l = v in LEADING ? LEADING[v] : v === "none" ? "1" : spacingValue(v);
    return l === null ? null : viaVariable("--tw-leading", "line-height", l);
  },
  tracking: (v, n) => {
    const t = v in TRACKING ? TRACKING[v] : arbitraryOnly(v);
    return t === null ? null : viaVariable("--tw-tracking", "letter-spacing", n ? `calc(${t} * -1)` : t);
  },
  decoration: one("text-decoration-color", textColour),
  placeholder: (v) => {
    const c = colour(v, "text");
    return c === null ? null : rule(decl("color", c), { pseudo: "::placeholder", tw: ["--tw-sort:placeholder-color", "color"] });
  },
  accent: one("accent-color", textColour),
  opacity: one("opacity", (v) => (isNumber(v) ? formatNumber(parseFloat(v) / 100) : arbitraryOnly(v))),
  shadow,
  ring: (v) => ringWidth(v) ?? one("--tw-ring-color", borderColour)(v),
  "ring-offset": (v) => (isInteger(v) ? decl("--tw-ring-offset-width", `${v}px`, "--tw-ring-offset-shadow", "var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) #fff") : null),
  outline: (v) => (isInteger(v) ? decl("outline-style", "solid", "outline-width", `${v}px`) : one("outline-color", borderColour)(v)),
  blur: (v) => {
    const radius = v in BLURS ? BLURS[v] : arbitraryOnly(v);
    return radius === null ? null : filterRule("--tw-blur", `blur(${radius})`);
  },
  brightness: filterFamily("--tw-brightness", "brightness"),
  contrast: filterFamily("--tw-contrast", "contrast"),
  saturate: filterFamily("--tw-saturate", "saturate"),
  transition,
  duration: (v) => {
    const d = isNumber(v) ? `${v}ms` : v === "initial" ? "initial" : arbitraryOnly(v);
    return d === null ? null : viaVariable("--tw-duration", "transition-duration", d);
  },
  ease: (v) => {
    const e = v in EASES ? EASES[v] : arbitraryOnly(v);
    return e === null ? null : viaVariable("--tw-ease", "transition-timing-function", e);
  },
};

const FUNCTIONAL_ROOTS = Object.keys(FUNCTIONAL).sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------------------
// Variants, in Tailwind's registration order (which is its sort order).
// ---------------------------------------------------------------------------------------

const VARIANTS = {
  "group-hover": { selector: (s) => `${s}:is(:where(.group):hover *)`, media: "@media (hover: hover)" },
  placeholder: { selector: (s) => `${s}::placeholder` },
  first: { selector: (s) => `${s}:first-child` },
  last: { selector: (s) => `${s}:last-child` },
  odd: { selector: (s) => `${s}:nth-child(odd)` },
  even: { selector: (s) => `${s}:nth-child(even)` },
  "focus-within": { selector: (s) => `${s}:focus-within` },
  hover: { selector: (s) => `${s}:hover`, media: "@media (hover: hover)" },
  focus: { selector: (s) => `${s}:focus` },
  "focus-visible": { selector: (s) => `${s}:focus-visible` },
  active: { selector: (s) => `${s}:active` },
  enabled: { selector: (s) => `${s}:enabled` },
  disabled: { selector: (s) => `${s}:disabled` },
  sm: { media: "@media (min-width: 40rem)" },
  lg: { media: "@media (min-width: 64rem)" },
};
const VARIANT_BIT = Object.fromEntries(Object.keys(VARIANTS).map((v, i) => [v, 1 << i]));

// ---------------------------------------------------------------------------------------
// Extraction: every string literal and template-literal chunk in src/**/*.{ts,tsx}, minus
// tests, split on whitespace. A chunk's token that abuts a `${}` is a fragment, not a class.
// ---------------------------------------------------------------------------------------

const APP_SHEETS = ["WireTAP.css", "styles/components.css"];
export const appCss = () => APP_SHEETS.map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8")).join("\n");
export const readSheet = () => (fs.existsSync(SHEET_PATH) ? fs.readFileSync(SHEET_PATH, "utf8") : "");

/** Class names the app's own sheets declare (`font-led`, `btn--icon`): never utilities. */
export function appClasses() {
  return new Set([...appCss().matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
}
const APP_CLASSES = appClasses();

/** Every .ts/.tsx under src/ except tests and declarations, relative to src/, sorted. */
const sourceFiles = () =>
  fs.readdirSync(SRC_DIR, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !/(^|\/)tests\//.test(f))
    .sort();

/** Whitespace-separated tokens of every string literal in a file, in source order. */
function stringTokens(file, source) {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const strings = [];
  (function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text.split(/\s+/));
    else if (ts.isTemplateExpression(node)) {
      const chunks = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      const tokens = [];
      chunks.forEach((chunk, i) => {
        const words = chunk.split(/\s+/);
        if (i > 0 && !/^\s/.test(chunk)) words.shift();
        if (i < chunks.length - 1 && !/\s$/.test(chunk)) words.pop();
        tokens.push(...words);
      });
      strings.push(tokens);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return strings.map((tokens) => tokens.filter(Boolean)).filter((tokens) => tokens.length);
}

// ---------------------------------------------------------------------------------------
// Candidate parsing and compilation
// ---------------------------------------------------------------------------------------

function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

class CandidateError extends Error {}

/**
 * Compile one class name. Returns null for a token that is not a utility, throws a
 * CandidateError for a token that is one but cannot be compiled.
 */
export function compile(token) {
  if (APP_CLASSES.has(token)) return null;
  const parts = splitVariants(token);
  let base = parts.pop();
  const variants = parts;
  if (!base) return null;

  const important = base.startsWith("!");
  if (important) base = base.slice(1);
  const negative = base.startsWith("-");
  if (negative) base = base.slice(1);
  // Inline CSS in a template string (`box-sizing: border-box;`) is not a class list.
  if (!base || /[^\w\-\[\]().,#%/:\\*'"]/.test(base)) return null;

  let compiled = null;
  if (isArbitrary(base) && !negative) {
    const m = /^\[([a-z-]+):(.+)\]$/.exec(base);
    if (m && !m[1].startsWith("--")) compiled = rule(decl(m[1], m[2].replace(/(?<!\\)_/g, " ")));
    else return null;
  } else if (!negative && base in STATIC) {
    compiled = STATIC[base];
  } else {
    const root = FUNCTIONAL_ROOTS.find((r) => base === r || base.startsWith(r + "-"));
    if (!root) return null;
    const value = base === root ? "" : base.slice(root.length + 1);
    if (value.includes("var(")) throw new CandidateError(`theme colours are named, not spelled: ${token}`);
    compiled = FUNCTIONAL[root](value, negative);
    if (compiled == null) {
      if (value === "") return null;
      throw new CandidateError(`unresolvable value: ${token}`);
    }
  }
  const { decls, tw, children = false, pseudo = "", keyframes = null } = Array.isArray(compiled) ? rule(compiled) : compiled;

  // Only now is an unknown variant an error: Tailwind would have compiled `dark:flex`,
  // `md:flex` or `[&_svg]:flex`, so dropping it would silently lose a rule.
  for (const v of variants) if (!(v in VARIANTS)) throw new CandidateError(`unsupported variant ${v}: in ${token}`);
  let selector = "." + escapeClass(token);
  const media = [];
  for (const v of variants) {
    const variant = VARIANTS[v];
    if (variant.selector) selector = variant.selector(selector);
    if (variant.media) media.push(variant.media);
  }
  selector += pseudo;
  if (children) selector = `:where(${selector} > :not(:last-child))`;

  const twProps = tw ?? decls.map(([p]) => p);
  return {
    token,
    variants,
    variantBits: variants.reduce((bits, v) => bits | VARIANT_BIT[v], 0),
    selector,
    media,
    decls: important ? decls.map(([p, v]) => [p, `${v} !important`]) : decls,
    sort: propertySort(twProps),
    keyframes,
  };
}

/** CSS.escape for a class name. */
function escapeClass(name) {
  return name.replace(/[^\w-]/g, (ch) => `\\${ch}`).replace(/^(\d)/, "\\3$1 ");
}

// ---------------------------------------------------------------------------------------
// Sorting — Tailwind 4's algorithm: variants first, then the sorted indices of each rule's
// properties in PROPERTY_ORDER compared element-wise (a missing index sorts last), then
// more declarations first, then the class name with digit runs compared numerically.
// A leading `--tw-sort:X` entry stands in for the whole property list, as it does in
// Tailwind's own utilities.
// ---------------------------------------------------------------------------------------

const PROPERTY_ORDER = `container-type pointer-events visibility position inset inset-inline inset-block
inset-inline-start inset-inline-end inset-block-start inset-block-end top right bottom left isolation
z-index order grid-column grid-column-start grid-column-end grid-row grid-row-start grid-row-end float
clear --tw-container-component margin margin-inline margin-block margin-inline-start margin-inline-end
margin-block-start margin-block-end margin-top margin-right margin-bottom margin-left box-sizing display
field-sizing aspect-ratio height max-height min-height width max-width min-width flex flex-shrink
flex-grow flex-basis table-layout caption-side border-collapse border-spacing transform-origin translate
--tw-translate-x --tw-translate-y --tw-translate-z scale --tw-scale-x --tw-scale-y --tw-scale-z rotate
--tw-rotate-x --tw-rotate-y --tw-rotate-z --tw-skew-x --tw-skew-y transform zoom animation cursor
touch-action --tw-pan-x --tw-pan-y --tw-pinch-zoom resize scroll-snap-type --tw-scroll-snap-strictness
scroll-snap-align scroll-snap-stop scroll-margin scroll-margin-inline scroll-margin-block
scroll-margin-inline-start scroll-margin-inline-end scroll-margin-block-start scroll-margin-block-end
scroll-margin-top scroll-margin-right scroll-margin-bottom scroll-margin-left scroll-padding
scroll-padding-inline scroll-padding-block scroll-padding-inline-start scroll-padding-inline-end
scroll-padding-block-start scroll-padding-block-end scroll-padding-top scroll-padding-right
scroll-padding-bottom scroll-padding-left scrollbar-width scrollbar-color scrollbar-gutter
list-style-position list-style-type list-style-image appearance columns break-before break-inside
break-after grid-auto-columns grid-auto-flow grid-auto-rows grid-template-columns grid-template-rows
flex-direction flex-wrap place-content place-items align-content align-items justify-content
justify-items gap column-gap row-gap --tw-space-x-reverse --tw-space-y-reverse divide-x-width
divide-y-width --tw-divide-y-reverse divide-style divide-color place-self align-self justify-self
overflow overflow-x overflow-y overscroll-behavior overscroll-behavior-x overscroll-behavior-y
scroll-behavior border-radius border-start-radius border-end-radius border-top-radius
border-right-radius border-bottom-radius border-left-radius border-start-start-radius
border-start-end-radius border-end-end-radius border-end-start-radius border-top-left-radius
border-top-right-radius border-bottom-right-radius border-bottom-left-radius border-width
border-inline-width border-block-width border-inline-start-width border-inline-end-width
border-block-start-width border-block-end-width border-top-width border-right-width
border-bottom-width border-left-width border-style border-inline-style border-block-style
border-inline-start-style border-inline-end-style border-block-start-style border-block-end-style
border-top-style border-right-style border-bottom-style border-left-style border-color
border-inline-color border-block-color border-inline-start-color border-inline-end-color
border-block-start-color border-block-end-color border-top-color border-right-color
border-bottom-color border-left-color background-color background-image --tw-gradient-position
--tw-gradient-stops --tw-gradient-via-stops --tw-gradient-from --tw-gradient-from-position
--tw-gradient-via --tw-gradient-via-position --tw-gradient-to --tw-gradient-to-position mask-image
--tw-mask-top --tw-mask-top-from-color --tw-mask-top-from-position --tw-mask-top-to-color
--tw-mask-top-to-position --tw-mask-right --tw-mask-right-from-color --tw-mask-right-from-position
--tw-mask-right-to-color --tw-mask-right-to-position --tw-mask-bottom --tw-mask-bottom-from-color
--tw-mask-bottom-from-position --tw-mask-bottom-to-color --tw-mask-bottom-to-position --tw-mask-left
--tw-mask-left-from-color --tw-mask-left-from-position --tw-mask-left-to-color --tw-mask-left-to-position
--tw-mask-linear --tw-mask-linear-position --tw-mask-linear-from-color --tw-mask-linear-from-position
--tw-mask-linear-to-color --tw-mask-linear-to-position --tw-mask-radial --tw-mask-radial-shape
--tw-mask-radial-size --tw-mask-radial-position --tw-mask-radial-from-color
--tw-mask-radial-from-position --tw-mask-radial-to-color --tw-mask-radial-to-position --tw-mask-conic
--tw-mask-conic-position --tw-mask-conic-from-color --tw-mask-conic-from-position
--tw-mask-conic-to-color --tw-mask-conic-to-position box-decoration-break background-size
background-attachment background-clip background-position background-repeat background-origin
mask-composite mask-mode mask-type mask-size mask-clip mask-position mask-repeat mask-origin fill
stroke stroke-width object-fit object-position padding padding-inline padding-block
padding-inline-start padding-inline-end padding-block-start padding-block-end padding-top
padding-right padding-bottom padding-left text-align text-indent vertical-align font-family
font-feature-settings font-size line-height font-weight letter-spacing text-wrap overflow-wrap
word-break text-overflow hyphens white-space tab-size color text-transform font-style font-stretch
font-variant-numeric text-decoration-line text-decoration-color text-decoration-style
text-decoration-thickness text-underline-offset -webkit-font-smoothing placeholder-color caret-color
accent-color color-scheme opacity background-blend-mode mix-blend-mode box-shadow --tw-shadow
--tw-shadow-color --tw-ring-shadow --tw-ring-color --tw-inset-shadow --tw-inset-shadow-color
--tw-inset-ring-shadow --tw-inset-ring-color --tw-ring-offset-width --tw-ring-offset-color outline
outline-width outline-offset outline-color --tw-blur --tw-brightness --tw-contrast --tw-drop-shadow
--tw-grayscale --tw-hue-rotate --tw-invert --tw-saturate --tw-sepia filter --tw-backdrop-blur
--tw-backdrop-brightness --tw-backdrop-contrast --tw-backdrop-grayscale --tw-backdrop-hue-rotate
--tw-backdrop-invert --tw-backdrop-opacity --tw-backdrop-saturate --tw-backdrop-sepia backdrop-filter
transition-property transition-behavior transition-delay transition-duration
transition-timing-function will-change contain content forced-color-adjust`.split(/\s+/);
const PROPERTY_INDEX = new Map(PROPERTY_ORDER.map((p, i) => [p, i]));

function propertySort(props) {
  const order = new Set();
  let pinned = false;
  for (const prop of props) {
    if (pinned) continue;
    if (prop.startsWith("--tw-sort:")) {
      order.add(PROPERTY_INDEX.get(prop.slice("--tw-sort:".length)));
      pinned = true;
    } else if (PROPERTY_INDEX.has(prop)) order.add(PROPERTY_INDEX.get(prop));
  }
  return { order: [...order].sort((a, b) => a - b), count: props.length };
}

/** Tailwind's candidate comparison: character by character, digit runs by numeric value. */
function compareNames(a, z) {
  const minLen = Math.min(a.length, z.length);
  for (let i = 0; i < minLen; i++) {
    const aCode = a.charCodeAt(i);
    const zCode = z.charCodeAt(i);
    if (isDigit(aCode) && isDigit(zCode)) {
      let aEnd = i + 1;
      let zEnd = i + 1;
      while (isDigit(a.charCodeAt(aEnd))) aEnd++;
      while (isDigit(z.charCodeAt(zEnd))) zEnd++;
      const aNum = a.slice(i, aEnd);
      const zNum = z.slice(i, zEnd);
      const diff = Number(aNum) - Number(zNum);
      if (diff) return diff;
      if (aNum < zNum) return -1;
      if (aNum > zNum) return 1;
      continue;
    }
    if (aCode !== zCode) return aCode - zCode;
  }
  return a.length - z.length;
}
const isDigit = (code) => code >= 48 && code <= 57;

function compareRules(a, z) {
  if (a.variantBits !== z.variantBits) return a.variantBits - z.variantBits;
  const ao = a.sort.order;
  const zo = z.sort.order;
  let i = 0;
  while (i < ao.length && i < zo.length && ao[i] === zo[i]) i++;
  return (ao[i] ?? Infinity) - (zo[i] ?? Infinity) || z.sort.count - a.sort.count || compareNames(a.token, z.token);
}

// ---------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------

/**
 * Compile every class name used under src/. Returns the sheet, and for the guard the class
 * strings that produced it and every source text. Throws when a class cannot be compiled.
 */
export function compileSource() {
  const rules = new Map();
  const errors = new Map();
  const classStrings = [];
  const sources = {};
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
    sources[file] = source;
    for (const tokens of stringTokens(file, source)) {
      // A string is a class list once one of its tokens is a utility; only then is a
      // token that names a family it cannot compile an error rather than prose.
      let isClassString = false;
      const failures = [];
      for (const token of tokens) {
        if (rules.has(token)) {
          isClassString = true;
          continue;
        }
        try {
          const compiled = compile(token);
          if (compiled) {
            rules.set(token, compiled);
            isClassString = true;
          }
        } catch (e) {
          if (!(e instanceof CandidateError)) throw e;
          failures.push(e.message);
        }
      }
      if (!isClassString) continue;
      classStrings.push({ file, tokens });
      for (const msg of failures) if (!errors.has(msg)) errors.set(msg, file);
    }
  }
  if (errors.size) {
    const lines = [...errors].map(([msg, file]) => `  ${msg}  (${file})`);
    throw new Error(`gen-utilities: ${errors.size} class name(s) cannot be compiled:\n${lines.join("\n")}`);
  }
  // Plain `filter: x()` replaces Tailwind's per-function variables, so two filter
  // utilities on one element would no longer compose. None do today; keep it that way.
  const clashes = filtersOnOneElement(classStrings, rules);
  if (clashes.length) throw new Error(`gen-utilities: filter utilities compose on one element:\n  ${clashes.join("\n  ")}`);

  const sorted = [...rules.values()].sort(compareRules);
  return { css: render(sorted), classStrings, sources };
}

function filtersOnOneElement(classStrings, rules) {
  const clashes = [];
  for (const { file, tokens } of classStrings) {
    const seen = new Map();
    for (const token of tokens) {
      const compiled = rules.get(token);
      if (!compiled?.decls.some(([p]) => p === "filter")) continue;
      const key = compiled.variants.join(":");
      if (seen.has(key) && seen.get(key) !== token) clashes.push(`${seen.get(key)} + ${token} (${file})`);
      seen.set(key, token);
    }
  }
  return clashes;
}

function renderRule({ selector, media, decls }) {
  const body = decls.map(([p, v]) => `${p}: ${v}`).join("; ");
  const open = media.map((m) => `${m} { `).join("");
  return `${open}${selector} { ${body} }${" }".repeat(media.length)}`;
}

function render(rules) {
  const lines = rules.filter((r) => r.decls.length).map(renderRule);
  const keyframes = [...new Set(rules.map((r) => r.keyframes).filter(Boolean))];
  return [
    "/* Generated by scripts/gen-utilities.mjs from the class names used under src/. Do not edit;",
    "   run `npm run gen:css`. Layered so the `!` utilities keep beating unlayered third-party CSS. */",
    "@layer utilities {",
    ...lines.map((l) => `  ${l}`),
    ...keyframes.map((k) => `  ${k}`),
    "}",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { css } = compileSource();
  fs.writeFileSync(SHEET_PATH, css);
  const rules = css.split("\n").filter((l) => /^  (?!@keyframes)[.:@]/.test(l)).length;
  console.log(`wrote ${path.relative(process.cwd(), SHEET_PATH)}: ${rules} rules, ${(Buffer.byteLength(css) / 1024).toFixed(1)} KB`);
}
