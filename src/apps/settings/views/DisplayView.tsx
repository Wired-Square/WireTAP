// ui/src/apps/settings/views/DisplayView.tsx

import ColourPicker from "../../../components/ColourPicker";
import { flexRowGap2 } from "../../../styles/spacing";
import { textMedium } from "../../../styles";
import {
  textPrimary,
  textSecondary,
  textTertiary,
  bgMuted,
  hoverSubtle,
} from "../../../styles/colourTokens";
import type { ThemeMode, ThemeColours } from "../stores/settingsStore";

type DisplayViewProps = {
  displayFrameIdFormat: "hex" | "decimal";
  onChangeFormat: (format: "hex" | "decimal") => void;
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  onChangeTimeFormat: (fmt: "delta-last" | "delta-start" | "timestamp" | "human") => void;
  timezone: "local" | "utc";
  onChangeTimezone: (tz: "local" | "utc") => void;
  signalColours: {
    none: string;
    low: string;
    medium: string;
    high: string;
  };
  onChangeSignalColour: (level: "none" | "low" | "medium" | "high", val: string) => void;
  onResetSignalColour: (level: "none" | "low" | "medium" | "high") => void;
  binaryOneColour: string;
  onChangeBinaryOneColour: (val: string) => void;
  onResetBinaryOneColour: () => void;
  binaryZeroColour: string;
  onChangeBinaryZeroColour: (val: string) => void;
  onResetBinaryZeroColour: () => void;
  binaryUnusedColour: string;
  onChangeBinaryUnusedColour: (val: string) => void;
  onResetBinaryUnusedColour: () => void;
  // Theme settings
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  themeColours: ThemeColours;
  onChangeThemeColour: (key: keyof ThemeColours, val: string) => void;
  onResetThemeColours: () => void;
};

export default function DisplayView({
  displayFrameIdFormat,
  onChangeFormat,
  displayTimeFormat,
  onChangeTimeFormat,
  timezone,
  onChangeTimezone,
  signalColours,
  onChangeSignalColour,
  onResetSignalColour,
  binaryOneColour,
  onChangeBinaryOneColour,
  onResetBinaryOneColour,
  binaryZeroColour,
  onChangeBinaryZeroColour,
  onResetBinaryZeroColour,
  binaryUnusedColour,
  onChangeBinaryUnusedColour,
  onResetBinaryUnusedColour,
  themeMode,
  onChangeThemeMode,
  themeColours,
  onChangeThemeColour,
  onResetThemeColours,
}: DisplayViewProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className={`text-xl font-semibold ${textPrimary}`}>Display</h2>
      </div>

      {/* Appearance Section */}
      <div className="space-y-2">
        <label className={`block ${textMedium}`}>
          Appearance
        </label>
        <div className="flex gap-3">
          {[
            { value: "auto", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ].map((opt) => (
            <label key={opt.value} className={`${flexRowGap2} text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="theme-mode"
                value={opt.value}
                checked={themeMode === opt.value}
                onChange={() => onChangeThemeMode(opt.value as ThemeMode)}
              />
              {opt.label}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>
          Choose light or dark theme, or follow your system preference.
        </p>
      </div>

      {/* Theme Colours Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-sm font-semibold ${textPrimary}`}>Theme Colours</h3>
          <button
            type="button"
            onClick={onResetThemeColours}
            className={`text-xs px-2 py-1 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
          >
            Reset All
          </button>
        </div>
        <p className={`text-sm ${textTertiary}`}>
          Customise the app's colour scheme.
        </p>

        <div className="grid grid-cols-2 gap-6">
          {/* Light Mode Colours */}
          <div className="space-y-2">
            <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>Light Mode</h4>
            <div className="space-y-1.5">
              <ColourPicker
                label="Background"
                value={themeColours.bgPrimaryLight}
                onChange={(val) => onChangeThemeColour("bgPrimaryLight", val)}
              />
              <ColourPicker
                label="Surface"
                value={themeColours.bgSurfaceLight}
                onChange={(val) => onChangeThemeColour("bgSurfaceLight", val)}
              />
              <ColourPicker
                label="Text"
                value={themeColours.textPrimaryLight}
                onChange={(val) => onChangeThemeColour("textPrimaryLight", val)}
              />
              <ColourPicker
                label="Secondary Text"
                value={themeColours.textSecondaryLight}
                onChange={(val) => onChangeThemeColour("textSecondaryLight", val)}
              />
              <ColourPicker
                label="Border"
                value={themeColours.borderDefaultLight}
                onChange={(val) => onChangeThemeColour("borderDefaultLight", val)}
              />
              <ColourPicker
                label="Data Background"
                value={themeColours.dataBgLight}
                onChange={(val) => onChangeThemeColour("dataBgLight", val)}
              />
              <ColourPicker
                label="Data Text"
                value={themeColours.dataTextPrimaryLight}
                onChange={(val) => onChangeThemeColour("dataTextPrimaryLight", val)}
              />
            </div>
          </div>

          {/* Dark Mode Colours */}
          <div className="space-y-2">
            <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>Dark Mode</h4>
            <div className="space-y-1.5">
              <ColourPicker
                label="Background"
                value={themeColours.bgPrimaryDark}
                onChange={(val) => onChangeThemeColour("bgPrimaryDark", val)}
              />
              <ColourPicker
                label="Surface"
                value={themeColours.bgSurfaceDark}
                onChange={(val) => onChangeThemeColour("bgSurfaceDark", val)}
              />
              <ColourPicker
                label="Text"
                value={themeColours.textPrimaryDark}
                onChange={(val) => onChangeThemeColour("textPrimaryDark", val)}
              />
              <ColourPicker
                label="Secondary Text"
                value={themeColours.textSecondaryDark}
                onChange={(val) => onChangeThemeColour("textSecondaryDark", val)}
              />
              <ColourPicker
                label="Border"
                value={themeColours.borderDefaultDark}
                onChange={(val) => onChangeThemeColour("borderDefaultDark", val)}
              />
              <ColourPicker
                label="Data Background"
                value={themeColours.dataBgDark}
                onChange={(val) => onChangeThemeColour("dataBgDark", val)}
              />
              <ColourPicker
                label="Data Text"
                value={themeColours.dataTextPrimaryDark}
                onChange={(val) => onChangeThemeColour("dataTextPrimaryDark", val)}
              />
            </div>
          </div>
        </div>

        {/* Accent Colours */}
        <div className="space-y-2 pt-2">
          <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>Accent Colours</h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <ColourPicker
              label="Primary"
              value={themeColours.accentPrimary}
              onChange={(val) => onChangeThemeColour("accentPrimary", val)}
            />
            <ColourPicker
              label="Success"
              value={themeColours.accentSuccess}
              onChange={(val) => onChangeThemeColour("accentSuccess", val)}
            />
            <ColourPicker
              label="Danger"
              value={themeColours.accentDanger}
              onChange={(val) => onChangeThemeColour("accentDanger", val)}
            />
            <ColourPicker
              label="Warning"
              value={themeColours.accentWarning}
              onChange={(val) => onChangeThemeColour("accentWarning", val)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>
          Display Frame ID as
        </label>
        <div className="flex gap-3">
          <label className={`${flexRowGap2} text-sm ${textPrimary}`}>
            <input
              type="radio"
              name="frame-id-format"
              value="hex"
              checked={displayFrameIdFormat === "hex"}
              onChange={() => onChangeFormat("hex")}
            />
            Hex
          </label>
          <label className={`${flexRowGap2} text-sm ${textPrimary}`}>
            <input
              type="radio"
              name="frame-id-format"
              value="decimal"
              checked={displayFrameIdFormat === "decimal"}
              onChange={() => onChangeFormat("decimal")}
            />
            Decimal
          </label>
        </div>
        <p className={`text-sm ${textTertiary}`}>
          Choose how CAN frame IDs are shown in the editor.
        </p>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>
          Display time as
        </label>
        <div className="flex flex-wrap gap-3">
          {[
            { value: "human", label: "Human friendly" },
            { value: "timestamp", label: "Timestamp" },
            { value: "delta-start", label: "Delta since start" },
            { value: "delta-last", label: "Delta since last message" },
          ].map((opt) => (
            <label key={opt.value} className={`flex items-center gap-2 text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="time-format"
                value={opt.value}
                checked={displayTimeFormat === opt.value}
                onChange={() => onChangeTimeFormat(opt.value as DisplayViewProps["displayTimeFormat"])}
              />
              {opt.label}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>
          Controls how timestamps are rendered in discovery and other views.
        </p>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>
          Default timezone
        </label>
        <div className="flex gap-3">
          {[
            { value: "local", label: "Local timezone" },
            { value: "utc", label: "UTC" },
          ].map((opt) => (
            <label key={opt.value} className={`flex items-center gap-2 text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="timezone"
                value={opt.value}
                checked={timezone === opt.value}
                onChange={() => onChangeTimezone(opt.value as "local" | "utc")}
              />
              {opt.label}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>
          Default timezone for clock displays. Click the timezone badge in views to temporarily override.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>Signals</h3>
        <p className={`text-sm ${textTertiary}`}>
          Configure colors for signal confidence indicators.
        </p>
        <div className="space-y-2">
          {([
            { key: "none", label: "No confidence", defaultVal: "#94a3b8" },
            { key: "low", label: "Low confidence", defaultVal: "#f59e0b" },
            { key: "medium", label: "Medium confidence", defaultVal: "#3b82f6" },
            { key: "high", label: "High confidence", defaultVal: "#22c55e" },
          ] as const).map((cfg) => (
            <div key={cfg.key} className={flexRowGap2}>
              <ColourPicker
                label={cfg.label}
                value={signalColours[cfg.key]}
                onChange={(val) => onChangeSignalColour(cfg.key, val)}
              />
              <button
                type="button"
                onClick={() => onResetSignalColour(cfg.key)}
                className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
                title="Reset to default"
              >
                ↺
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>Binary Display</h3>
        <p className={`text-sm ${textTertiary}`}>
          Configure colors for binary bits in the Frame Calculator and bit previews.
        </p>
        <div className="space-y-2">
          <div className={flexRowGap2}>
            <ColourPicker
              label="Binary 1 colour"
              value={binaryOneColour}
              onChange={onChangeBinaryOneColour}
            />
            <button
              type="button"
              onClick={onResetBinaryOneColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title="Reset to default"
            >
              ↺
            </button>
          </div>
          <div className={flexRowGap2}>
            <ColourPicker
              label="Binary 0 colour"
              value={binaryZeroColour}
              onChange={onChangeBinaryZeroColour}
            />
            <button
              type="button"
              onClick={onResetBinaryZeroColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title="Reset to default"
            >
              ↺
            </button>
          </div>
          <div className={flexRowGap2}>
            <ColourPicker
              label="Unused bits colour"
              value={binaryUnusedColour}
              onChange={onChangeBinaryUnusedColour}
            />
            <button
              type="button"
              onClick={onResetBinaryUnusedColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title="Reset to default"
            >
              ↺
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
