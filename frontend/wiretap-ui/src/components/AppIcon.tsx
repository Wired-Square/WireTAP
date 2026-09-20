// The app-hue primitive: renders the `.app-hue` classes in styles/components.css.
// `appHueClass` puts an app's accent on an element — `--app-accent` and the
// tint mixed from it — for whatever inside reads them; `AppIcon` is the app's
// glyph in that accent, which is how its tab, its top bar, the launcher and the
// session canvas name it. `null` is a subscriber that is not a panel (an MCP
// client): a neutral glyph, no hue.

import { AppWindow } from "lucide-react";
import { appById, type PanelId } from "../apps/registry";

export function appHueClass(app: PanelId | null, className = ""): string {
  return ["app-hue", app && `app-hue--${appById[app].hue}`, className].filter(Boolean).join(" ");
}

export function AppIcon({ app, className = "" }: { app: PanelId | null; className?: string }) {
  const Icon = app ? appById[app].icon : AppWindow;
  return <Icon className={appHueClass(app, `app-hue__icon ${className}`)} />;
}
