// Single source of truth for the application's launcher panels.
//
// Adding a new app: add ONE entry to `src/apps/apps.json` (structural data —
// id, label, group, accelerator, singleton) and ONE entry to `visualConfig`
// below (icon, hue, lazy import). Both the TypeScript surfaces (Dockview
// registry, LogoMenu, Watermark, AppTab, AppTopBar) and the Rust native menu
// fan out from these two places.
//
// Hidden Dockview-only panels (analysis tools opened programmatically from
// inside Discovery / Decoder) are declared inline in `hiddenApps` below —
// they don't appear in apps.json since the Rust menu doesn't reference them.

import type { ComponentType } from "react";
import {
  Search,
  Activity,
  Send,
  DatabaseZap,
  Gauge,
  Workflow,
  FileText,
  Calculator,
  FlaskConical,
  Network,
  Terminal,
  Settings as SettingsIcon,
  GitCompare,
  ListOrdered,
  type LucideIcon,
} from "lucide-react";
import appsJson from "./apps.json";

export type AppGroup =
  | "sessions"
  | "database"
  | "framelink"
  | "utilities"
  | "settings";

/** A data accent of the theme (`--text-<hue>`), read by `.app-hue--<hue>`; drawn by components/AppIcon.tsx. */
export type AppHue =
  | "purple"
  | "green"
  | "red"
  | "pink"
  | "sky"
  | "yellow"
  | "indigo"
  | "blue"
  | "teal"
  | "emerald"
  | "cyan"
  | "orange";

type AppVisual = {
  icon: LucideIcon;
  hue: AppHue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ default: ComponentType<any> }>;
};

// Visual config for every panel (menu + hidden). Keys define the canonical
// PanelId union — TypeScript will catch any apps.json id without a matching
// entry here at the runtime check below.
const visualConfig = {
  // Menu apps — order/group come from apps.json.
  discovery: {
    icon: Search,
    hue: "purple",
    load: () => import("./discovery/Discovery"),
  },
  decoder: {
    icon: Activity,
    hue: "green",
    load: () => import("./decoder/Decoder"),
  },
  transmit: {
    icon: Send,
    hue: "red",
    load: () => import("./transmit/Transmit"),
  },
  dashboard: {
    icon: Gauge,
    hue: "pink",
    load: () => import("./dashboard/Dashboard"),
  },
  serial: {
    icon: Terminal,
    hue: "sky",
    load: () => import("./serial/Serial"),
  },
  query: {
    icon: DatabaseZap,
    hue: "yellow",
    load: () => import("./query/Query"),
  },
  rules: {
    icon: Workflow,
    hue: "indigo",
    load: () => import("./rules/Rules"),
  },
  "catalog-editor": {
    icon: FileText,
    hue: "blue",
    load: () => import("./catalog/CatalogEditor"),
  },
  "frame-calculator": {
    icon: Calculator,
    hue: "teal",
    load: () => import("./calculator/FrameCalculator"),
  },
  "test-pattern": {
    icon: FlaskConical,
    hue: "emerald",
    load: () => import("./test-pattern/TestPattern"),
  },
  "session-manager": {
    icon: Network,
    hue: "cyan",
    load: () => import("./session-manager/SessionManager"),
  },
  settings: {
    icon: SettingsIcon,
    hue: "orange",
    load: () => import("./settings/Settings"),
  },
  // Hidden Dockview-only panels (no apps.json entry, no menu presence). They
  // hold Discovery's result views, so they wear Discovery's hue.
  "payload-analysis": {
    icon: GitCompare,
    hue: "purple",
    load: () => import("./analysis/PayloadAnalysis"),
  },
  "frame-order-analysis": {
    icon: ListOrdered,
    hue: "purple",
    load: () => import("./analysis/FrameOrderAnalysis"),
  },
} as const satisfies Record<string, AppVisual>;

export type PanelId = keyof typeof visualConfig;

export const isPanelId = (id: string): id is PanelId => id in visualConfig;

type SharedAppEntry = {
  id: PanelId;
  label: string;
  group: AppGroup;
  accelerator?: string;
  singleton?: boolean;
  /** Tab can have a session/source attached (consumes `requestSessionJoin`). */
  sessionAware?: boolean;
};

/** Group order from apps.json — used by LogoMenu and Watermark for layout. */
export const menuGroupOrder = appsJson.groupOrder as AppGroup[];

const sharedApps = appsJson.apps as SharedAppEntry[];

// Sanity check: every apps.json entry must have visualConfig.
for (const a of sharedApps) {
  if (!(a.id in visualConfig)) {
    throw new Error(
      `[apps/registry] apps.json contains "${a.id}" but no visualConfig entry exists. ` +
        `Add one to src/apps/registry.ts.`,
    );
  }
}

/** Panel ids that declare `sessionAware` in apps.json — tabs a session can be attached to. */
export const sessionAwarePanelIds: ReadonlySet<string> = new Set(
  sharedApps.filter((a) => a.sessionAware).map((a) => a.id),
);

export type MenuApp = SharedAppEntry & { i18nKey: string } & AppVisual;

export type HiddenApp = { id: PanelId; i18nKey: string } & AppVisual;

export type AppEntry = MenuApp | HiddenApp;

/** Apps that appear in LogoMenu / Watermark / native menu, in declared order. */
export const menuApps: MenuApp[] = sharedApps.map((a) => ({
  ...a,
  i18nKey: kebabToCamel(a.id),
  ...visualConfig[a.id],
})) as MenuApp[];

const hiddenApps: HiddenApp[] = [
  {
    id: "payload-analysis",
    i18nKey: "payloadAnalysis",
    ...visualConfig["payload-analysis"],
  },
  {
    id: "frame-order-analysis",
    i18nKey: "frameOrderAnalysis",
    ...visualConfig["frame-order-analysis"],
  },
];

/** All Dockview-registered panels (menu + hidden). */
export const apps: AppEntry[] = [...menuApps, ...hiddenApps];

/** Lookup by panel id — used by AppTab and MainLayout. */
export const appById: Record<PanelId, AppEntry> = Object.fromEntries(
  apps.map((a) => [a.id, a]),
) as Record<PanelId, AppEntry>;

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}
