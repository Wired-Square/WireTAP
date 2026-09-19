#!/usr/bin/env node
// Generates src/styles/utilities.css: the app's own utility sheet, keeping Tailwind's
// class names so no component changes. Every string literal under src/ is scanned for
// class names, each is compiled through the family table below, and the rules are
// sorted the way Tailwind 4 sorts them. Values are resolved — no theme variables —
// except the ring/shadow, translate and gradient variables, which compose across
// classes on one element (see the Tailwind Removal Feasibility note, Phase 1).
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
// Theme values, from tailwindcss/theme.css (4.3.0). Colours are kept as oklch verbatim:
// converting to hex would shift them and change out-of-gamut mapping.
// ---------------------------------------------------------------------------------------

const PALETTE = {
  red: { 50: "oklch(97.1% 0.013 17.38)", 100: "oklch(93.6% 0.032 17.717)", 200: "oklch(88.5% 0.062 18.334)", 300: "oklch(80.8% 0.114 19.571)", 400: "oklch(70.4% 0.191 22.216)", 500: "oklch(63.7% 0.237 25.331)", 600: "oklch(57.7% 0.245 27.325)", 700: "oklch(50.5% 0.213 27.518)", 800: "oklch(44.4% 0.177 26.899)", 900: "oklch(39.6% 0.141 25.723)", 950: "oklch(25.8% 0.092 26.042)" },
  orange: { 50: "oklch(98% 0.016 73.684)", 100: "oklch(95.4% 0.038 75.164)", 200: "oklch(90.1% 0.076 70.697)", 300: "oklch(83.7% 0.128 66.29)", 400: "oklch(75% 0.183 55.934)", 500: "oklch(70.5% 0.213 47.604)", 600: "oklch(64.6% 0.222 41.116)", 700: "oklch(55.3% 0.195 38.402)", 800: "oklch(47% 0.157 37.304)", 900: "oklch(40.8% 0.123 38.172)", 950: "oklch(26.6% 0.079 36.259)" },
  amber: { 50: "oklch(98.7% 0.022 95.277)", 100: "oklch(96.2% 0.059 95.617)", 200: "oklch(92.4% 0.12 95.746)", 300: "oklch(87.9% 0.169 91.605)", 400: "oklch(82.8% 0.189 84.429)", 500: "oklch(76.9% 0.188 70.08)", 600: "oklch(66.6% 0.179 58.318)", 700: "oklch(55.5% 0.163 48.998)", 800: "oklch(47.3% 0.137 46.201)", 900: "oklch(41.4% 0.112 45.904)", 950: "oklch(27.9% 0.077 45.635)" },
  yellow: { 50: "oklch(98.7% 0.026 102.212)", 100: "oklch(97.3% 0.071 103.193)", 200: "oklch(94.5% 0.129 101.54)", 300: "oklch(90.5% 0.182 98.111)", 400: "oklch(85.2% 0.199 91.936)", 500: "oklch(79.5% 0.184 86.047)", 600: "oklch(68.1% 0.162 75.834)", 700: "oklch(55.4% 0.135 66.442)", 800: "oklch(47.6% 0.114 61.907)", 900: "oklch(42.1% 0.095 57.708)", 950: "oklch(28.6% 0.066 53.813)" },
  lime: { 50: "oklch(98.6% 0.031 120.757)", 100: "oklch(96.7% 0.067 122.328)", 200: "oklch(93.8% 0.127 124.321)", 300: "oklch(89.7% 0.196 126.665)", 400: "oklch(84.1% 0.238 128.85)", 500: "oklch(76.8% 0.233 130.85)", 600: "oklch(64.8% 0.2 131.684)", 700: "oklch(53.2% 0.157 131.589)", 800: "oklch(45.3% 0.124 130.933)", 900: "oklch(40.5% 0.101 131.063)", 950: "oklch(27.4% 0.072 132.109)" },
  green: { 50: "oklch(98.2% 0.018 155.826)", 100: "oklch(96.2% 0.044 156.743)", 200: "oklch(92.5% 0.084 155.995)", 300: "oklch(87.1% 0.15 154.449)", 400: "oklch(79.2% 0.209 151.711)", 500: "oklch(72.3% 0.219 149.579)", 600: "oklch(62.7% 0.194 149.214)", 700: "oklch(52.7% 0.154 150.069)", 800: "oklch(44.8% 0.119 151.328)", 900: "oklch(39.3% 0.095 152.535)", 950: "oklch(26.6% 0.065 152.934)" },
  emerald: { 50: "oklch(97.9% 0.021 166.113)", 100: "oklch(95% 0.052 163.051)", 200: "oklch(90.5% 0.093 164.15)", 300: "oklch(84.5% 0.143 164.978)", 400: "oklch(76.5% 0.177 163.223)", 500: "oklch(69.6% 0.17 162.48)", 600: "oklch(59.6% 0.145 163.225)", 700: "oklch(50.8% 0.118 165.612)", 800: "oklch(43.2% 0.095 166.913)", 900: "oklch(37.8% 0.077 168.94)", 950: "oklch(26.2% 0.051 172.552)" },
  teal: { 50: "oklch(98.4% 0.014 180.72)", 100: "oklch(95.3% 0.051 180.801)", 200: "oklch(91% 0.096 180.426)", 300: "oklch(85.5% 0.138 181.071)", 400: "oklch(77.7% 0.152 181.912)", 500: "oklch(70.4% 0.14 182.503)", 600: "oklch(60% 0.118 184.704)", 700: "oklch(51.1% 0.096 186.391)", 800: "oklch(43.7% 0.078 188.216)", 900: "oklch(38.6% 0.063 188.416)", 950: "oklch(27.7% 0.046 192.524)" },
  cyan: { 50: "oklch(98.4% 0.019 200.873)", 100: "oklch(95.6% 0.045 203.388)", 200: "oklch(91.7% 0.08 205.041)", 300: "oklch(86.5% 0.127 207.078)", 400: "oklch(78.9% 0.154 211.53)", 500: "oklch(71.5% 0.143 215.221)", 600: "oklch(60.9% 0.126 221.723)", 700: "oklch(52% 0.105 223.128)", 800: "oklch(45% 0.085 224.283)", 900: "oklch(39.8% 0.07 227.392)", 950: "oklch(30.2% 0.056 229.695)" },
  sky: { 50: "oklch(97.7% 0.013 236.62)", 100: "oklch(95.1% 0.026 236.824)", 200: "oklch(90.1% 0.058 230.902)", 300: "oklch(82.8% 0.111 230.318)", 400: "oklch(74.6% 0.16 232.661)", 500: "oklch(68.5% 0.169 237.323)", 600: "oklch(58.8% 0.158 241.966)", 700: "oklch(50% 0.134 242.749)", 800: "oklch(44.3% 0.11 240.79)", 900: "oklch(39.1% 0.09 240.876)", 950: "oklch(29.3% 0.066 243.157)" },
  blue: { 50: "oklch(97% 0.014 254.604)", 100: "oklch(93.2% 0.032 255.585)", 200: "oklch(88.2% 0.059 254.128)", 300: "oklch(80.9% 0.105 251.813)", 400: "oklch(70.7% 0.165 254.624)", 500: "oklch(62.3% 0.214 259.815)", 600: "oklch(54.6% 0.245 262.881)", 700: "oklch(48.8% 0.243 264.376)", 800: "oklch(42.4% 0.199 265.638)", 900: "oklch(37.9% 0.146 265.522)", 950: "oklch(28.2% 0.091 267.935)" },
  indigo: { 50: "oklch(96.2% 0.018 272.314)", 100: "oklch(93% 0.034 272.788)", 200: "oklch(87% 0.065 274.039)", 300: "oklch(78.5% 0.115 274.713)", 400: "oklch(67.3% 0.182 276.935)", 500: "oklch(58.5% 0.233 277.117)", 600: "oklch(51.1% 0.262 276.966)", 700: "oklch(45.7% 0.24 277.023)", 800: "oklch(39.8% 0.195 277.366)", 900: "oklch(35.9% 0.144 278.697)", 950: "oklch(25.7% 0.09 281.288)" },
  violet: { 50: "oklch(96.9% 0.016 293.756)", 100: "oklch(94.3% 0.029 294.588)", 200: "oklch(89.4% 0.057 293.283)", 300: "oklch(81.1% 0.111 293.571)", 400: "oklch(70.2% 0.183 293.541)", 500: "oklch(60.6% 0.25 292.717)", 600: "oklch(54.1% 0.281 293.009)", 700: "oklch(49.1% 0.27 292.581)", 800: "oklch(43.2% 0.232 292.759)", 900: "oklch(38% 0.189 293.745)", 950: "oklch(28.3% 0.141 291.089)" },
  purple: { 50: "oklch(97.7% 0.014 308.299)", 100: "oklch(94.6% 0.033 307.174)", 200: "oklch(90.2% 0.063 306.703)", 300: "oklch(82.7% 0.119 306.383)", 400: "oklch(71.4% 0.203 305.504)", 500: "oklch(62.7% 0.265 303.9)", 600: "oklch(55.8% 0.288 302.321)", 700: "oklch(49.6% 0.265 301.924)", 800: "oklch(43.8% 0.218 303.724)", 900: "oklch(38.1% 0.176 304.987)", 950: "oklch(29.1% 0.149 302.717)" },
  fuchsia: { 50: "oklch(97.7% 0.017 320.058)", 100: "oklch(95.2% 0.037 318.852)", 200: "oklch(90.3% 0.076 319.62)", 300: "oklch(83.3% 0.145 321.434)", 400: "oklch(74% 0.238 322.16)", 500: "oklch(66.7% 0.295 322.15)", 600: "oklch(59.1% 0.293 322.896)", 700: "oklch(51.8% 0.253 323.949)", 800: "oklch(45.2% 0.211 324.591)", 900: "oklch(40.1% 0.17 325.612)", 950: "oklch(29.3% 0.136 325.661)" },
  pink: { 50: "oklch(97.1% 0.014 343.198)", 100: "oklch(94.8% 0.028 342.258)", 200: "oklch(89.9% 0.061 343.231)", 300: "oklch(82.3% 0.12 346.018)", 400: "oklch(71.8% 0.202 349.761)", 500: "oklch(65.6% 0.241 354.308)", 600: "oklch(59.2% 0.249 0.584)", 700: "oklch(52.5% 0.223 3.958)", 800: "oklch(45.9% 0.187 3.815)", 900: "oklch(40.8% 0.153 2.432)", 950: "oklch(28.4% 0.109 3.907)" },
  rose: { 50: "oklch(96.9% 0.015 12.422)", 100: "oklch(94.1% 0.03 12.58)", 200: "oklch(89.2% 0.058 10.001)", 300: "oklch(81% 0.117 11.638)", 400: "oklch(71.2% 0.194 13.428)", 500: "oklch(64.5% 0.246 16.439)", 600: "oklch(58.6% 0.253 17.585)", 700: "oklch(51.4% 0.222 16.935)", 800: "oklch(45.5% 0.188 13.697)", 900: "oklch(41% 0.159 10.272)", 950: "oklch(27.1% 0.105 12.094)" },
  slate: { 50: "oklch(98.4% 0.003 247.858)", 100: "oklch(96.8% 0.007 247.896)", 200: "oklch(92.9% 0.013 255.508)", 300: "oklch(86.9% 0.022 252.894)", 400: "oklch(70.4% 0.04 256.788)", 500: "oklch(55.4% 0.046 257.417)", 600: "oklch(44.6% 0.043 257.281)", 700: "oklch(37.2% 0.044 257.287)", 800: "oklch(27.9% 0.041 260.031)", 900: "oklch(20.8% 0.042 265.755)", 950: "oklch(12.9% 0.042 264.695)" },
  gray: { 50: "oklch(98.5% 0.002 247.839)", 100: "oklch(96.7% 0.003 264.542)", 200: "oklch(92.8% 0.006 264.531)", 300: "oklch(87.2% 0.01 258.338)", 400: "oklch(70.7% 0.022 261.325)", 500: "oklch(55.1% 0.027 264.364)", 600: "oklch(44.6% 0.03 256.802)", 700: "oklch(37.3% 0.034 259.733)", 800: "oklch(27.8% 0.033 256.848)", 900: "oklch(21% 0.034 264.665)", 950: "oklch(13% 0.028 261.692)" },
  zinc: { 50: "oklch(98.5% 0 0)", 100: "oklch(96.7% 0.001 286.375)", 200: "oklch(92% 0.004 286.32)", 300: "oklch(87.1% 0.006 286.286)", 400: "oklch(70.5% 0.015 286.067)", 500: "oklch(55.2% 0.016 285.938)", 600: "oklch(44.2% 0.017 285.786)", 700: "oklch(37% 0.013 285.805)", 800: "oklch(27.4% 0.006 286.033)", 900: "oklch(21% 0.006 285.885)", 950: "oklch(14.1% 0.005 285.823)" },
  neutral: { 50: "oklch(98.5% 0 0)", 100: "oklch(97% 0 0)", 200: "oklch(92.2% 0 0)", 300: "oklch(87% 0 0)", 400: "oklch(70.8% 0 0)", 500: "oklch(55.6% 0 0)", 600: "oklch(43.9% 0 0)", 700: "oklch(37.1% 0 0)", 800: "oklch(26.9% 0 0)", 900: "oklch(20.5% 0 0)", 950: "oklch(14.5% 0 0)" },
  stone: { 50: "oklch(98.5% 0.001 106.423)", 100: "oklch(97% 0.001 106.424)", 200: "oklch(92.3% 0.003 48.717)", 300: "oklch(86.9% 0.005 56.366)", 400: "oklch(70.9% 0.01 56.259)", 500: "oklch(55.3% 0.013 58.071)", 600: "oklch(44.4% 0.011 73.639)", 700: "oklch(37.4% 0.01 67.558)", 800: "oklch(26.8% 0.007 34.298)", 900: "oklch(21.6% 0.006 56.043)", 950: "oklch(14.7% 0.004 49.25)" },
  mauve: { 50: "oklch(98.5% 0 0)", 100: "oklch(96% 0.003 325.6)", 200: "oklch(92.2% 0.005 325.62)", 300: "oklch(86.5% 0.012 325.68)", 400: "oklch(71.1% 0.019 323.02)", 500: "oklch(54.2% 0.034 322.5)", 600: "oklch(43.5% 0.029 321.78)", 700: "oklch(36.4% 0.029 323.89)", 800: "oklch(26.3% 0.024 320.12)", 900: "oklch(21.2% 0.019 322.12)", 950: "oklch(14.5% 0.008 326)" },
  olive: { 50: "oklch(98.8% 0.003 106.5)", 100: "oklch(96.6% 0.005 106.5)", 200: "oklch(93% 0.007 106.5)", 300: "oklch(88% 0.011 106.6)", 400: "oklch(73.7% 0.021 106.9)", 500: "oklch(58% 0.031 107.3)", 600: "oklch(46.6% 0.025 107.3)", 700: "oklch(39.4% 0.023 107.4)", 800: "oklch(28.6% 0.016 107.4)", 900: "oklch(22.8% 0.013 107.4)", 950: "oklch(15.3% 0.006 107.1)" },
  mist: { 50: "oklch(98.7% 0.002 197.1)", 100: "oklch(96.3% 0.002 197.1)", 200: "oklch(92.5% 0.005 214.3)", 300: "oklch(87.2% 0.007 219.6)", 400: "oklch(72.3% 0.014 214.4)", 500: "oklch(56% 0.021 213.5)", 600: "oklch(45% 0.017 213.2)", 700: "oklch(37.8% 0.015 216)", 800: "oklch(27.5% 0.011 216.9)", 900: "oklch(21.8% 0.008 223.9)", 950: "oklch(14.8% 0.004 228.8)" },
  taupe: { 50: "oklch(98.6% 0.002 67.8)", 100: "oklch(96% 0.002 17.2)", 200: "oklch(92.2% 0.005 34.3)", 300: "oklch(86.8% 0.007 39.5)", 400: "oklch(71.4% 0.014 41.2)", 500: "oklch(54.7% 0.021 43.1)", 600: "oklch(43.8% 0.017 39.3)", 700: "oklch(36.7% 0.016 35.7)", 800: "oklch(26.8% 0.011 36.5)", 900: "oklch(21.4% 0.009 43.1)", 950: "oklch(14.7% 0.004 49.3)" },
};
const NAMED_COLOURS = { white: "#fff", black: "#000", transparent: "transparent", current: "currentcolor", inherit: "inherit" };

const SPACING_REM = 0.25;
const CONTAINERS = { "3xs": "16rem", "2xs": "18rem", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem" };
const TEXT_SIZES = {
  xs: ["0.75rem", "calc(1 / 0.75)"], sm: ["0.875rem", "calc(1.25 / 0.875)"], base: ["1rem", "calc(1.5 / 1)"],
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

/** Tailwind colour syntax: palette-shade, named, arbitrary, each with an optional /alpha. */
function colour(v) {
  const slash = v.lastIndexOf("/");
  let base = v;
  let alpha = null;
  if (slash > 0 && !v.slice(slash).includes("]")) {
    base = v.slice(0, slash);
    alpha = v.slice(slash + 1);
    if (!isNumber(alpha)) return null;
  }
  let resolved;
  if (base in NAMED_COLOURS) resolved = NAMED_COLOURS[base];
  else if (isArbitrary(base)) {
    const { hint, value } = arbitrary(base);
    if (hint && hint !== "color") return null;
    if (!hint && !/^(var\(|#|rgb|hsl|okl|color|current)/.test(value)) return null;
    resolved = value;
  } else {
    const m = /^([a-z]+)-(\d+)$/.exec(base);
    if (!m || !PALETTE[m[1]]?.[m[2]]) return null;
    resolved = PALETTE[m[1]][m[2]];
  }
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
  const c = colour(v);
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
  const c = colour(v);
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
  const c = colour(v);
  return c ? rule(decl("border-color", c), { children: true, tw: ["--tw-sort:divide-color", "border-color"] }) : null;
}

function text(v) {
  if (v in TEXT_SIZES) return decl("font-size", TEXT_SIZES[v][0], "line-height", TEXT_SIZES[v][1]);
  if (isArbitrary(v)) {
    const { hint, value } = arbitrary(v);
    if (hint === "length" || (hint === null && isLengthLike(value))) return decl("font-size", value);
  }
  const c = colour(v);
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
  const c = colour(v);
  return c ? decl("background-color", c) : null;
}

function gradientStop(stop, v) {
  const c = colour(v);
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
  fill: one("fill", colour),
  stroke: one("stroke", colour),
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
  decoration: one("text-decoration-color", colour),
  placeholder: (v) => {
    const c = colour(v);
    return c === null ? null : rule(decl("color", c), { pseudo: "::placeholder", tw: ["--tw-sort:placeholder-color", "color"] });
  },
  accent: one("accent-color", colour),
  opacity: one("opacity", (v) => (isNumber(v) ? formatNumber(parseFloat(v) / 100) : arbitraryOnly(v))),
  shadow,
  ring: (v) => ringWidth(v) ?? one("--tw-ring-color", colour)(v),
  "ring-offset": (v) => (isInteger(v) ? decl("--tw-ring-offset-width", `${v}px`, "--tw-ring-offset-shadow", "var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) #fff") : null),
  outline: (v) => (isInteger(v) ? decl("outline-style", "solid", "outline-width", `${v}px`) : one("outline-color", colour)(v)),
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
