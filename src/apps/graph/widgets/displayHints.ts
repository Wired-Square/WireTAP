// ui/src/apps/graph/widgets/displayHints.ts
//
// Per-signal `display` hints from a catalog. The Rust catalog crate drops the
// unknown `display` key on parse, but the raw TOML is carried through to the
// frontend (ParsedCatalog.rawToml), so we re-parse it here to recover hints.
//
// A hint is either a widget-type shorthand string, or a table with `widget` plus
// widget-specific keys (snake_case), e.g.:
//
//   [[frame.can."0x123".signals]]
//   name = "SteeringAngle"
//   display = "rotary"
//
//   [[frame.can."0x200".signals]]
//   name = "Headlight"
//   display = { widget = "icon-state" }

import { parse as parseToml } from "smol-toml";
import type { PanelType } from "../../../stores/graphStore";

export type DisplayHint = PanelType | ({ widget: PanelType } & Record<string, unknown>);

/** Widget type a hint asks for (string shorthand or `{ widget }` table). */
export function hintWidget(hint: DisplayHint): PanelType {
  return typeof hint === "string" ? hint : hint.widget;
}

/** Re-parse raw catalog TOML into per-signal display hints, keyed "frameId:signalName". */
export function parseDisplayHints(rawToml: string): Map<string, DisplayHint> {
  const map = new Map<string, DisplayHint>();
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(rawToml) as Record<string, unknown>;
  } catch {
    return map;
  }
  const frameRoot = doc.frame as Record<string, unknown> | undefined;
  if (!frameRoot || typeof frameRoot !== "object") return map;

  for (const proto of Object.keys(frameRoot)) {            // can | serial | modbus
    const frames = frameRoot[proto] as Record<string, unknown> | undefined;
    if (!frames || typeof frames !== "object") continue;
    for (const idKey of Object.keys(frames)) {
      const frameId = parseInt(idKey, /^0x/i.test(idKey) ? 16 : 10);
      if (Number.isNaN(frameId)) continue;
      const signals = (frames[idKey] as Record<string, unknown> | undefined)?.signals;
      if (!Array.isArray(signals)) continue;
      for (const sig of signals as Array<Record<string, unknown>>) {
        const name = sig?.name;
        const display = sig?.display;
        if (typeof name === "string" && display != null) {
          map.set(`${frameId}:${name}`, display as DisplayHint);
        }
      }
    }
  }
  return map;
}
