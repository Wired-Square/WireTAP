// ui/src/apps/catalog/toml.ts

import TOML from "smol-toml";

// The catalogue editor's sidebar tree is now built from the Rust-resolved model
// (`catalog.parse` → `catalogToTree`), so the former TypeScript semantic parser
// (`parseTomlToTree`) is gone. `tomlParse` remains as the read-only raw-TOML
// accessor that the per-node edit dialogs/views use to read a single frame's
// authoring object out of the document.
export function tomlParse(text: string): any {
  return TOML.parse(text);
}
