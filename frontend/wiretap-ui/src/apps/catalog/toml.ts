// ui/src/apps/catalog/toml.ts

import TOML from "smol-toml";

// Read-only raw TOML for the catalogue report, the last reader left.
export function tomlParse(text: string): any {
  return TOML.parse(text);
}
