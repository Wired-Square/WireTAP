// ui/src/apps/dashboard/widgets/configTypes.ts
//
// Per-widget configuration blobs. `panel.type` is the discriminator; each widget
// reads its own optional key off `panel.widgetConfig`. Keeping these out of the
// flat `DashboardPanel` interface avoids bloating the shared shape as widgets grow.

/** Icon-state widget — maps a signal value to a lucide icon + colour + brightness. */
export interface IconStateConfig {
  primarySignalIndex?: number;
  states: Array<{
    value: number;
    /** lucide icon name (resolved via the allow-list in lucideByName.ts) */
    icon: string;
    colour: string;
    /** 0..1 — drives opacity + glow */
    brightness?: number;
    label?: string;
  }>;
  fallback?: { icon: string; colour: string };
}

/** Rotary / steering-wheel widget — a scalar mapped to a rotation angle. */
export interface RotaryConfig {
  /** Sweep start/end in degrees (default ±450 for a full steering wheel). */
  startAngle?: number;
  endAngle?: number;
  /** Optional lucide glyph to rotate; defaults to a drawn steering wheel. */
  icon?: string;
  showReadout?: boolean;
  primarySignalIndex?: number;
}

/** Level bar + readout — a scalar mapped to a fill fraction. */
export interface LevelBarConfig {
  orientation?: 'horizontal' | 'vertical';
  primarySignalIndex?: number;
  /** Colour zones, each applying from its `at` value upward. */
  thresholds?: Array<{ at: number; colour: string }>;
}

/** Bitfield / flags grid — per-bit on/off of a frame's latest bytes. */
export interface BitfieldConfig {
  targetFrameId?: number;
  byteCount?: number;
  /** Optional label per bit index (0..63). */
  labels?: Record<number, string>;
  onColour?: string;
  offColour?: string;
}

/** Animated scriptable custom canvas — author draw fn run in a Worker sandbox. */
export interface RawCanvasConfig {
  /** Author-supplied: `(ctx, { signals, width, height, time, dt }) => void` */
  code: string;
  /** Ordered "frameId:signalName" keys fed in as the `signals` array.
   *  When omitted, the panel's bound signals are used in order. */
  signalKeys?: string[];
  /** Frame-rate cap (default 30). */
  fps?: number;
}

/** A declarative sub-instrument within a custom-SVG cluster. */
export type SceneNode =
  | { kind: 'arc'; cx: number; cy: number; r: number; startAngle: number; endAngle: number; thickness: number; bind: SceneBind; colour?: string; thresholds?: Array<{ at: number; colour: string }> }
  | { kind: 'needle'; cx: number; cy: number; length: number; startAngle: number; endAngle: number; bind: SceneBind; colour?: string }
  | { kind: 'lamp'; cx: number; cy: number; r: number; bind: { signalKey: string }; states: Array<{ value: number; colour: string; brightness?: number }> }
  | { kind: 'bar'; x: number; y: number; w: number; h: number; orientation: 'horizontal' | 'vertical'; bind: SceneBind; colour?: string }
  | { kind: 'text'; x: number; y: number; bind?: { signalKey: string }; template?: string; unit?: string; fontSize?: number; colour?: string };

export interface SceneBind {
  signalKey: string;
  min: number;
  max: number;
}

/** Complex custom SVG — declarative scene-graph OR scriptable markup. */
export interface CustomSvgConfig {
  mode?: 'scene' | 'script';
  /** Shared coordinate system for declarative composition (default "0 0 200 200"). */
  viewBox?: string;
  /** Declarative mode: ordered sub-instruments. */
  scene?: SceneNode[];
  /** Script mode: author fn `(signals, { time, dt, width, height }) => svgMarkupString`. */
  code?: string;
  /** Ordered "frameId:signalName" keys fed to script mode / referenced by scene binds. */
  signalKeys?: string[];
  fps?: number;
}

/** Per-widget config bag carried on a panel. Keyed by widget, discriminated by `panel.type`. */
export interface WidgetConfig {
  iconState?: IconStateConfig;
  rotary?: RotaryConfig;
  levelBar?: LevelBarConfig;
  bitfield?: BitfieldConfig;
  rawCanvas?: RawCanvasConfig;
  customSvg?: CustomSvgConfig;
}
