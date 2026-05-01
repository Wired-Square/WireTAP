// ui/src/apps/settings/views/DisplayView.tsx

import { useTranslation } from "react-i18next";
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
  // Frame editor signal colours
  frameEditorColours: string[];
  onChangeFrameEditorColour: (index: number, val: string) => void;
  onResetFrameEditorColours: () => void;
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
  frameEditorColours,
  onChangeFrameEditorColour,
  onResetFrameEditorColours,
  themeMode,
  onChangeThemeMode,
  themeColours,
  onChangeThemeColour,
  onResetThemeColours,
}: DisplayViewProps) {
  const { t } = useTranslation("settings");
  const resetTooltip = t("display.signals.resetTooltip");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className={`text-xl font-semibold ${textPrimary}`}>{t("display.title")}</h2>
      </div>

      {/* Appearance Section */}
      <div className="space-y-2">
        <label className={`block ${textMedium}`}>{t("display.appearance.label")}</label>
        <div className="flex gap-3">
          {(["auto", "light", "dark"] as const).map((value) => (
            <label key={value} className={`${flexRowGap2} text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="theme-mode"
                value={value}
                checked={themeMode === value}
                onChange={() => onChangeThemeMode(value as ThemeMode)}
              />
              {t(`display.appearance.options.${value}`)}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.appearance.help")}</p>
      </div>

      {/* Theme Colours Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.themeColours.title")}</h3>
          <button
            type="button"
            onClick={onResetThemeColours}
            className={`text-xs px-2 py-1 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
          >
            {t("display.themeColours.resetAll")}
          </button>
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.themeColours.help")}</p>

        <div className="grid grid-cols-2 gap-6">
          {/* Light Mode Colours */}
          <div className="space-y-2">
            <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>
              {t("display.themeColours.lightMode")}
            </h4>
            <div className="space-y-1.5">
              <ColourPicker
                label={t("display.themeColours.labels.background")}
                value={themeColours.bgPrimaryLight}
                onChange={(val) => onChangeThemeColour("bgPrimaryLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.surface")}
                value={themeColours.bgSurfaceLight}
                onChange={(val) => onChangeThemeColour("bgSurfaceLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.text")}
                value={themeColours.textPrimaryLight}
                onChange={(val) => onChangeThemeColour("textPrimaryLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.secondaryText")}
                value={themeColours.textSecondaryLight}
                onChange={(val) => onChangeThemeColour("textSecondaryLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.border")}
                value={themeColours.borderDefaultLight}
                onChange={(val) => onChangeThemeColour("borderDefaultLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.dataBackground")}
                value={themeColours.dataBgLight}
                onChange={(val) => onChangeThemeColour("dataBgLight", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.dataText")}
                value={themeColours.dataTextPrimaryLight}
                onChange={(val) => onChangeThemeColour("dataTextPrimaryLight", val)}
              />
            </div>
          </div>

          {/* Dark Mode Colours */}
          <div className="space-y-2">
            <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>
              {t("display.themeColours.darkMode")}
            </h4>
            <div className="space-y-1.5">
              <ColourPicker
                label={t("display.themeColours.labels.background")}
                value={themeColours.bgPrimaryDark}
                onChange={(val) => onChangeThemeColour("bgPrimaryDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.surface")}
                value={themeColours.bgSurfaceDark}
                onChange={(val) => onChangeThemeColour("bgSurfaceDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.text")}
                value={themeColours.textPrimaryDark}
                onChange={(val) => onChangeThemeColour("textPrimaryDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.secondaryText")}
                value={themeColours.textSecondaryDark}
                onChange={(val) => onChangeThemeColour("textSecondaryDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.border")}
                value={themeColours.borderDefaultDark}
                onChange={(val) => onChangeThemeColour("borderDefaultDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.dataBackground")}
                value={themeColours.dataBgDark}
                onChange={(val) => onChangeThemeColour("dataBgDark", val)}
              />
              <ColourPicker
                label={t("display.themeColours.labels.dataText")}
                value={themeColours.dataTextPrimaryDark}
                onChange={(val) => onChangeThemeColour("dataTextPrimaryDark", val)}
              />
            </div>
          </div>
        </div>

        {/* Accent Colours */}
        <div className="space-y-2 pt-2">
          <h4 className={`text-xs font-medium ${textSecondary} uppercase tracking-wide`}>
            {t("display.themeColours.accentTitle")}
          </h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <ColourPicker
              label={t("display.themeColours.labels.primary")}
              value={themeColours.accentPrimary}
              onChange={(val) => onChangeThemeColour("accentPrimary", val)}
            />
            <ColourPicker
              label={t("display.themeColours.labels.success")}
              value={themeColours.accentSuccess}
              onChange={(val) => onChangeThemeColour("accentSuccess", val)}
            />
            <ColourPicker
              label={t("display.themeColours.labels.danger")}
              value={themeColours.accentDanger}
              onChange={(val) => onChangeThemeColour("accentDanger", val)}
            />
            <ColourPicker
              label={t("display.themeColours.labels.warning")}
              value={themeColours.accentWarning}
              onChange={(val) => onChangeThemeColour("accentWarning", val)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>{t("display.frameIdFormat.label")}</label>
        <div className="flex gap-3">
          {(["hex", "decimal"] as const).map((value) => (
            <label key={value} className={`${flexRowGap2} text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="frame-id-format"
                value={value}
                checked={displayFrameIdFormat === value}
                onChange={() => onChangeFormat(value)}
              />
              {t(`display.frameIdFormat.options.${value}`)}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.frameIdFormat.help")}</p>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>{t("display.timeFormat.label")}</label>
        <div className="flex flex-wrap gap-3">
          {(["human", "timestamp", "delta-start", "delta-last"] as const).map((value) => (
            <label key={value} className={`flex items-center gap-2 text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="time-format"
                value={value}
                checked={displayTimeFormat === value}
                onChange={() => onChangeTimeFormat(value)}
              />
              {t(`display.timeFormat.options.${value}`)}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.timeFormat.help")}</p>
      </div>

      <div className="space-y-2">
        <label className={`block ${textMedium}`}>{t("display.timezone.label")}</label>
        <div className="flex gap-3">
          {(["local", "utc"] as const).map((value) => (
            <label key={value} className={`flex items-center gap-2 text-sm ${textPrimary}`}>
              <input
                type="radio"
                name="timezone"
                value={value}
                checked={timezone === value}
                onChange={() => onChangeTimezone(value)}
              />
              {t(`display.timezone.options.${value}`)}
            </label>
          ))}
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.timezone.help")}</p>
      </div>

      <div className="space-y-3">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.signals.title")}</h3>
        <p className={`text-sm ${textTertiary}`}>{t("display.signals.help")}</p>
        <div className="space-y-2">
          {(["none", "low", "medium", "high"] as const).map((key) => (
            <div key={key} className={flexRowGap2}>
              <ColourPicker
                label={t(`display.signals.levels.${key}`)}
                value={signalColours[key]}
                onChange={(val) => onChangeSignalColour(key, val)}
              />
              <button
                type="button"
                onClick={() => onResetSignalColour(key)}
                className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
                title={resetTooltip}
              >
                ↺
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.binary.title")}</h3>
        <p className={`text-sm ${textTertiary}`}>{t("display.binary.help")}</p>
        <div className="space-y-2">
          <div className={flexRowGap2}>
            <ColourPicker
              label={t("display.binary.oneLabel")}
              value={binaryOneColour}
              onChange={onChangeBinaryOneColour}
            />
            <button
              type="button"
              onClick={onResetBinaryOneColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title={resetTooltip}
            >
              ↺
            </button>
          </div>
          <div className={flexRowGap2}>
            <ColourPicker
              label={t("display.binary.zeroLabel")}
              value={binaryZeroColour}
              onChange={onChangeBinaryZeroColour}
            />
            <button
              type="button"
              onClick={onResetBinaryZeroColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title={resetTooltip}
            >
              ↺
            </button>
          </div>
          <div className={flexRowGap2}>
            <ColourPicker
              label={t("display.binary.unusedLabel")}
              value={binaryUnusedColour}
              onChange={onChangeBinaryUnusedColour}
            />
            <button
              type="button"
              onClick={onResetBinaryUnusedColour}
              className={`p-2 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
              title={resetTooltip}
            >
              ↺
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.frameEditor.title")}</h3>
          <button
            type="button"
            onClick={onResetFrameEditorColours}
            className={`text-xs px-2 py-1 rounded ${bgMuted} ${textSecondary} ${hoverSubtle}`}
          >
            {t("display.frameEditor.resetAll")}
          </button>
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.frameEditor.help")}</p>
        <div className="space-y-2">
          {frameEditorColours.map((colour, i) => (
            <div key={i} className={flexRowGap2}>
              <ColourPicker
                label={t("display.frameEditor.signalLabel", { index: i + 1 })}
                value={colour}
                onChange={(val) => onChangeFrameEditorColour(i, val)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
