// The owned utility sheet replaces Tailwind's utility layer, so nothing checks the class
// names at build time any more. These assertions do that job over the source instead:
// the committed sheet is what the generator produces, the token layer's vocabulary is all
// real utilities, and every CSS variable a component reads is one the app declares.

import { describe, it, expect } from "vitest";
import { appClasses, appCss, compile, compileSource, readSheet } from "../../scripts/gen-utilities.mjs";
import pkg from "../../package.json";

const SHEET = readSheet();
const WIRETAP_CSS = appCss();
const APP_CLASSES = appClasses();
const { css, classStrings, sources } = compileSource();

const declarations = (text: string) => [...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
const DECLARED = new Set(declarations(WIRETAP_CSS));

// The exported reports carry their own :root in reportExport.ts; a report module reads it.
const REPORT_THEME = declarations(sources["utils/reportExport.ts"]);

/** Every `var(--x)` read but declared in neither WireTAP.css nor the reading file, by name → files. */
function undefinedVariables(): Map<string, Set<string>> {
  const undefinedVars = new Map<string, Set<string>>();
  for (const [file, text] of [...Object.entries(sources), ["WireTAP.css", WIRETAP_CSS]]) {
    const local = new Set([...declarations(text), ...(/from ['"]\.\/reportExport['"]/.test(text) ? REPORT_THEME : [])]);
    for (const m of text.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
      if (DECLARED.has(m[1]) || local.has(m[1])) continue;
      if (!undefinedVars.has(m[1])) undefinedVars.set(m[1], new Set());
      undefinedVars.get(m[1])!.add(file);
    }
  }
  return undefinedVars;
}
const UNDEFINED = undefinedVariables();

// Set at runtime by the iOS safe-area plugin (`main.tsx`), not by the app's CSS.
const RUNTIME_DEFINED_VARIABLES = ["--safe-area-inset-bottom"];

describe("utilities.css", () => {
  it("finds the sheet, the source and the variables (guards the extractors themselves)", () => {
    expect(SHEET.split("\n").filter((l) => /^  [.:@]/.test(l)).length).toBeGreaterThan(500);
    expect(Object.keys(sources).length).toBeGreaterThan(500);
    expect(classStrings.length).toBeGreaterThan(1000);
    expect(DECLARED.size).toBeGreaterThan(80);
    expect(compile("flex")).toMatchObject({ selector: ".flex", decls: [["display", "flex"]] });
  });

  it("is what the generator produces from the source, byte for byte", () => {
    expect(css, "src/styles/utilities.css is stale — run npm run gen:css").toBe(SHEET);
  });

  it("resolves every class the token layer (src/styles/*.ts) names", () => {
    const tokenLayer = classStrings.filter(({ file }) => file.startsWith("styles/"));
    expect(tokenLayer.length).toBeGreaterThan(50);
    const unresolved = tokenLayer.flatMap(({ file, tokens }) =>
      tokens.filter((t) => !compile(t) && !APP_CLASSES.has(t)).map((t) => `${t} (${file})`),
    );
    expect(unresolved, "tokens in styles/*.ts class strings that are neither utilities nor WireTAP.css classes").toEqual([]);
  });

  it("declares every CSS variable a component reads", () => {
    const unregistered = [...UNDEFINED].filter(([name]) => !RUNTIME_DEFINED_VARIABLES.includes(name));
    expect(
      unregistered.map(([name, files]) => `${name} in ${[...files].join(", ")}`),
      "var(--x) read but declared in neither WireTAP.css nor the file that reads it",
    ).toEqual([]);
  });

  it("has no Tailwind or PostCSS left in the package", () => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /tailwind|postcss|autoprefixer/.test(d))).toEqual([]);
    expect(WIRETAP_CSS).not.toMatch(/@import\s+["']tailwindcss["']/);
  });
});
