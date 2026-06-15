// ui/src/apps/graph/widgets/lucideByName.ts
//
// Allow-listed lucide icons addressable by (kebab-case) name, for the icon-state
// widget. Curated to common indicator/telltale glyphs so the bundle stays lean
// and author-supplied names are bounded. Unknown names fall back to `circle`.

import type { LucideIcon } from "lucide-react";
import {
  Lightbulb, LightbulbOff, Power, PowerOff, Zap, ZapOff,
  AlertTriangle, AlertCircle, CircleCheck, CircleX, Circle, CircleDot,
  Fan, Thermometer, ThermometerSnowflake, ThermometerSun, Droplet, Droplets,
  Flame, Snowflake, Wind, Sun, Moon, CloudRain,
  Battery, BatteryCharging, BatteryLow, BatteryFull, BatteryWarning,
  Lock, Unlock, Bell, BellOff, Wifi, WifiOff, Signal, Bluetooth,
  Gauge, Activity, Fuel, Plug, ToggleLeft, ToggleRight,
  Eye, EyeOff, Volume2, VolumeX, Play, Pause, Square,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, RotateCw,
  Car, CarFront, Cog, Wrench, KeyRound, DoorOpen, DoorClosed,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "lightbulb": Lightbulb,
  "lightbulb-off": LightbulbOff,
  "power": Power,
  "power-off": PowerOff,
  "zap": Zap,
  "zap-off": ZapOff,
  "alert-triangle": AlertTriangle,
  "alert-circle": AlertCircle,
  "circle-check": CircleCheck,
  "circle-x": CircleX,
  "circle": Circle,
  "circle-dot": CircleDot,
  "fan": Fan,
  "thermometer": Thermometer,
  "thermometer-snowflake": ThermometerSnowflake,
  "thermometer-sun": ThermometerSun,
  "droplet": Droplet,
  "droplets": Droplets,
  "flame": Flame,
  "snowflake": Snowflake,
  "wind": Wind,
  "sun": Sun,
  "moon": Moon,
  "cloud-rain": CloudRain,
  "battery": Battery,
  "battery-charging": BatteryCharging,
  "battery-low": BatteryLow,
  "battery-full": BatteryFull,
  "battery-warning": BatteryWarning,
  "lock": Lock,
  "unlock": Unlock,
  "bell": Bell,
  "bell-off": BellOff,
  "wifi": Wifi,
  "wifi-off": WifiOff,
  "signal": Signal,
  "bluetooth": Bluetooth,
  "gauge": Gauge,
  "activity": Activity,
  "fuel": Fuel,
  "plug": Plug,
  "toggle-left": ToggleLeft,
  "toggle-right": ToggleRight,
  "eye": Eye,
  "eye-off": EyeOff,
  "volume-2": Volume2,
  "volume-x": VolumeX,
  "play": Play,
  "pause": Pause,
  "square": Square,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "rotate-cw": RotateCw,
  "car": Car,
  "car-front": CarFront,
  "cog": Cog,
  "wrench": Wrench,
  "key-round": KeyRound,
  "door-open": DoorOpen,
  "door-closed": DoorClosed,
};

/** Resolve a lucide icon by kebab-case name; falls back to `circle`. */
export function lucideByName(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Circle;
}

/** Names available to the icon-state config UI / auto-config. */
export const ICON_NAMES: string[] = Object.keys(ICONS);
