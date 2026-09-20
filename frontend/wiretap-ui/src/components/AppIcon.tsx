// The app-hue primitive: renders the `.app-hue` classes in styles/components.css.
// `appHueClass` puts an app's accent on an element — `--app-accent` and the
// tints mixed from it — for whatever inside reads them; `AppIcon` is the app's
// glyph in that accent, which is how its tab, its top bar, the launcher and the
// session canvas name it.

import { appById, type PanelId } from "../apps/registry";

export function appHueClass(app: PanelId, className = ""): string {
  return `app-hue app-hue--${appById[app].hue} ${className}`.trim();
}

export function AppIcon({ app, className = "" }: { app: PanelId; className?: string }) {
  const Icon = appById[app].icon;
  return <Icon className={appHueClass(app, `text-[color:var(--app-accent)] shrink-0 ${className}`)} />;
}
