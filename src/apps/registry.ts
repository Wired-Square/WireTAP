// Single source of truth for the application's launcher panels.
//
// Adding a new app: add ONE entry to `src/apps/apps.json` (structural data —
// id, label, group, accelerator, singleton) and ONE entry to `visualConfig`
// below (icon, colour, lazy import). Both the TypeScript surfaces (Dockview
// registry, LogoMenu, Watermark, AppTab) and the Rust native menu fan out
// from these two places.
//
// Hidden Dockview-only panels (analysis tools opened programmatically from
// inside Discovery / Decoder) are declared inline in `hiddenApps` below —
// they don't appear in apps.json since the Rust menu doesn't reference them.

import type { ComponentType } from "react";
import {
  Search,
  Activity,
  Send,
  Server,
  DatabaseZap,
  BarChart3,
  Workflow,
  FileText,
  Calculator,
  FlaskConical,
  Network,
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

// Visual config for every panel (menu + hidden). Keys define the canonical
// PanelId union — TypeScript will catch any apps.json id without a matching
// entry here at the runtime check below.
const visualConfig = {
  // Menu apps — order/group come from apps.json.
  discovery: {
    icon: Search,
    colour: "text-purple-400",
    bgColour: "hover:bg-purple-500/10",
    watermarkBg: "bg-purple-500/10 hover:bg-purple-500/20",
    load: () => import("./discovery/Discovery"),
  },
  decoder: {
    icon: Activity,
    colour: "text-green-400",
    bgColour: "hover:bg-green-500/10",
    watermarkBg: "bg-green-500/10 hover:bg-green-500/20",
    load: () => import("./decoder/Decoder"),
  },
  transmit: {
    icon: Send,
    colour: "text-red-400",
    bgColour: "hover:bg-red-500/10",
    watermarkBg: "bg-red-500/10 hover:bg-red-500/20",
    load: () => import("./transmit/Transmit"),
  },
  graph: {
    icon: BarChart3,
    colour: "text-pink-400",
    bgColour: "hover:bg-pink-500/10",
    watermarkBg: "bg-pink-500/10 hover:bg-pink-500/20",
    load: () => import("./graph/Graph"),
  },
  modbus: {
    icon: Server,
    colour: "text-amber-400",
    bgColour: "hover:bg-amber-500/10",
    watermarkBg: "bg-amber-500/10 hover:bg-amber-500/20",
    load: () => import("./modbus/Modbus"),
  },
  query: {
    icon: DatabaseZap,
    colour: "text-yellow-400",
    bgColour: "hover:bg-yellow-500/10",
    watermarkBg: "bg-yellow-500/10 hover:bg-yellow-500/20",
    load: () => import("./query/Query"),
  },
  rules: {
    icon: Workflow,
    colour: "text-indigo-400",
    bgColour: "hover:bg-indigo-500/10",
    watermarkBg: "bg-indigo-500/10 hover:bg-indigo-500/20",
    load: () => import("./rules/Rules"),
  },
  "catalog-editor": {
    icon: FileText,
    colour: "text-blue-400",
    bgColour: "hover:bg-blue-500/10",
    watermarkBg: "bg-blue-500/10 hover:bg-blue-500/20",
    load: () => import("./catalog/CatalogEditor"),
  },
  "frame-calculator": {
    icon: Calculator,
    colour: "text-teal-400",
    bgColour: "hover:bg-teal-500/10",
    watermarkBg: "bg-teal-500/10 hover:bg-teal-500/20",
    load: () => import("./calculator/FrameCalculator"),
  },
  "test-pattern": {
    icon: FlaskConical,
    colour: "text-emerald-400",
    bgColour: "hover:bg-emerald-500/10",
    watermarkBg: "bg-emerald-500/10 hover:bg-emerald-500/20",
    load: () => import("./test-pattern/TestPattern"),
  },
  "session-manager": {
    icon: Network,
    colour: "text-cyan-400",
    bgColour: "hover:bg-cyan-500/10",
    watermarkBg: "bg-cyan-500/10 hover:bg-cyan-500/20",
    load: () => import("./session-manager/SessionManager"),
  },
  settings: {
    icon: SettingsIcon,
    colour: "text-orange-400",
    bgColour: "hover:bg-orange-500/10",
    watermarkBg: "bg-orange-500/10 hover:bg-orange-500/20",
    load: () => import("./settings/Settings"),
  },
  // Hidden Dockview-only panels (no apps.json entry, no menu presence).
  "payload-analysis": {
    icon: GitCompare,
    colour: "text-pink-400",
    load: () => import("./analysis/PayloadAnalysis"),
  },
  "frame-order-analysis": {
    icon: ListOrdered,
    colour: "text-amber-400",
    load: () => import("./analysis/FrameOrderAnalysis"),
  },
} as const satisfies Record<
  string,
  {
    icon: LucideIcon;
    colour: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    load: () => Promise<{ default: ComponentType<any> }>;
    bgColour?: string;
    watermarkBg?: string;
  }
>;

export type PanelId = keyof typeof visualConfig;

type SharedAppEntry = {
  id: PanelId;
  label: string;
  group: AppGroup;
  accelerator?: string;
  singleton?: boolean;
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

export type MenuApp = SharedAppEntry & {
  i18nKey: string;
  icon: LucideIcon;
  colour: string;
  bgColour: string;
  watermarkBg: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ default: ComponentType<any> }>;
};

export type HiddenApp = {
  id: PanelId;
  i18nKey: string;
  icon: LucideIcon;
  colour: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ default: ComponentType<any> }>;
};

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
