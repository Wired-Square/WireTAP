// ui/src/hooks/useNativeMenuLabels.ts
// Keeps the native menu bar in the active i18n language.

import { useEffect } from "react";
import i18n from "../i18n";
import menus from "../locales/en-AU/menus.json";
import { menuApps } from "../apps/registry";
import { setNativeMenuLabels } from "../api/menu";
import type { NativeMenuLabels } from "../generated/NativeMenuLabels";

type FixedLabel = Exclude<keyof NativeMenuLabels, "apps">;

const FIXED_LABELS = Object.keys(menus.nativeMenu satisfies Record<FixedLabel, string>) as FixedLabel[];

// i18next doesn't re-interpolate an inserted value, so this leaves the slot for Rust to fill.
const NAME_SLOT = "{{name}}";

export function buildNativeMenuLabels(): NativeMenuLabels {
  const fixed = Object.fromEntries(
    FIXED_LABELS.map((key) => [key, i18n.t(`menus:nativeMenu.${key}`, { name: NAME_SLOT })]),
  ) as Record<FixedLabel, string>;
  const apps = Object.fromEntries(menuApps.map((a) => [a.id, i18n.t(`menus:panels.${a.i18nKey}`)]));
  return { ...fixed, apps };
}

export function useNativeMenuLabels() {
  useEffect(() => {
    const send = () => void setNativeMenuLabels(buildNativeMenuLabels());
    send();
    i18n.on("languageChanged", send);
    return () => i18n.off("languageChanged", send);
  }, []);
}
