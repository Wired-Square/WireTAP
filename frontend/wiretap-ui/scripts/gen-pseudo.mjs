#!/usr/bin/env node
// Generates src/locales/xx-PS/: en-AU with every string wrapped in ⟦…⟧, so text still in
// plain English under the pseudo language is text that never went through i18next.
//
//   npm run gen:pseudo     rewrite the locale

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const SOURCE_DIR = path.join(LOCALES_DIR, "en-AU");
const PSEUDO_DIR = path.join(LOCALES_DIR, "xx-PS");

export function pseudoTree(value) {
  if (typeof value === "string") return `⟦${value}⟧`;
  if (Array.isArray(value)) return value.map(pseudoTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pseudoTree(v)]));
  return value;
}

const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

export function generatePseudo() {
  return Object.fromEntries(
    jsonFiles(SOURCE_DIR).map((file) => {
      const tree = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
      return [file, `${JSON.stringify(pseudoTree(tree), null, 2)}\n`];
    }),
  );
}

export function readPseudo() {
  return Object.fromEntries(jsonFiles(PSEUDO_DIR).map((file) => [file, fs.readFileSync(path.join(PSEUDO_DIR, file), "utf8")]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = generatePseudo();
  fs.mkdirSync(PSEUDO_DIR, { recursive: true });
  for (const stale of jsonFiles(PSEUDO_DIR).filter((f) => !(f in files))) fs.rmSync(path.join(PSEUDO_DIR, stale));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(PSEUDO_DIR, file), text);
  console.log(`wrote ${path.relative(process.cwd(), PSEUDO_DIR)}: ${Object.keys(files).length} namespaces`);
}
