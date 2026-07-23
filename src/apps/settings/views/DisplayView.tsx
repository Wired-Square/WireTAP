// ui/src/apps/settings/views/DisplayView.tsx

import { useTranslation } from "react-i18next";
import ColourPicker from "../../../components/ColourPicker";
import {
  flexRowGap2,
  h2,
  sectionHeader,
  resetButtonSmall,
  resetButtonIcon,
  textPrimary,
  textTertiary,
} from "../../../styles";
import { SettingRadioGroup } from "../components/rows";
import type { ThemeMode, ThemeColours } from "../stores/settingsStore";

// Theme-colour rows: one entry per swatch, paired light/dark keys. Keeps the two
// mode columns from drifting apart.
const THEME_ROWS: { label: string; light: keyof ThemeColours; dark: keyof ThemeColours }[] = [
  { label: "background", light: "bgPrimaryLight", dark: "bgPrimaryDark" },
  { label: "surface", light: "bgSurfaceLight", dark: "bgSurfaceDark" },
  { label: "text", light: "textPrimaryLight", dark: "textPrimaryDark" },
  { label: "secondaryText", light: "textSecondaryLight", dark: "textSecondaryDark" },
  { label: "border", light: "borderDefaultLight", dark: "borderDefaultDark" },
  { label: "dataBackground", light: "dataBgLight", dark: "dataBgDark" },
  { label: "dataText", light: "dataTextPrimaryLight", dark: "dataTextPrimaryDark" },
];

const ACCENT_ROWS: { label: string; key: keyof ThemeColours }[] = [
  { label: "primary", key: "accentPrimary" },
  { label: "success", key: "accentSuccess" },
  { label: "danger", key: "accentDanger" },
  { label: "warning", key: "accentWarning" },
];

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
      <h2 className={h2}>{t("display.title")}</h2>

      {/* Appearance Section */}
      <SettingRadioGroup
        label={t("display.appearance.label")}
        name="theme-mode"
        value={themeMode}
        onChange={onChangeThemeMode}
        options={[
          { value: "auto", label: t("display.appearance.options.auto") },
          { value: "light", label: t("display.appearance.options.light") },
          { value: "dark", label: t("display.appearance.options.dark") },
        ]}
        help={t("display.appearance.help")}
      />

      {/* Theme Colours Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.themeColours.title")}</h3>
          <button type="button" onClick={onResetThemeColours} className={resetButtonSmall}>
            {t("display.themeColours.resetAll")}
          </button>
        </div>
        <p className={`text-sm ${textTertiary}`}>{t("display.themeColours.help")}</p>

        <div className="grid grid-cols-2 gap-6">
          {/* Light Mode Colours */}
          <div className="space-y-2">
            <h4 className={sectionHeader}>{t("display.themeColours.lightMode")}</h4>
            <div className="space-y-1.5">
              {THEME_ROWS.map((row) => (
                <ColourPicker
                  key={row.light}
                  label={t(`display.themeColours.labels.${row.label}`)}
                  value={themeColours[row.light]}
                  onChange={(val) => onChangeThemeColour(row.light, val)}
                />
              ))}
            </div>
          </div>

          {/* Dark Mode Colours */}
          <div className="space-y-2">
            <h4 className={sectionHeader}>{t("display.themeColours.darkMode")}</h4>
            <div className="space-y-1.5">
              {THEME_ROWS.map((row) => (
                <ColourPicker
                  key={row.dark}
                  label={t(`display.themeColours.labels.${row.label}`)}
                  value={themeColours[row.dark]}
                  onChange={(val) => onChangeThemeColour(row.dark, val)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Accent Colours */}
        <div className="space-y-2 pt-2">
          <h4 className={sectionHeader}>{t("display.themeColours.accentTitle")}</h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {ACCENT_ROWS.map((row) => (
              <ColourPicker
                key={row.key}
                label={t(`display.themeColours.labels.${row.label}`)}
                value={themeColours[row.key]}
                onChange={(val) => onChangeThemeColour(row.key, val)}
              />
            ))}
          </div>
        </div>
      </div>

      <SettingRadioGroup
        label={t("display.frameIdFormat.label")}
        name="frame-id-format"
        value={displayFrameIdFormat}
        onChange={onChangeFormat}
        options={[
          { value: "hex", label: t("display.frameIdFormat.options.hex") },
          { value: "decimal", label: t("display.frameIdFormat.options.decimal") },
        ]}
        help={t("display.frameIdFormat.help")}
      />

      <SettingRadioGroup
        label={t("display.timeFormat.label")}
        name="time-format"
        value={displayTimeFormat}
        onChange={onChangeTimeFormat}
        wrap
        options={[
          { value: "human", label: t("display.timeFormat.options.human") },
          { value: "timestamp", label: t("display.timeFormat.options.timestamp") },
          { value: "delta-start", label: t("display.timeFormat.options.delta-start") },
          { value: "delta-last", label: t("display.timeFormat.options.delta-last") },
        ]}
        help={t("display.timeFormat.help")}
      />

      <SettingRadioGroup
        label={t("display.timezone.label")}
        name="timezone"
        value={timezone}
        onChange={onChangeTimezone}
        options={[
          { value: "local", label: t("display.timezone.options.local") },
          { value: "utc", label: t("display.timezone.options.utc") },
        ]}
        help={t("display.timezone.help")}
      />

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
                className={resetButtonIcon}
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
          {[
            {
              label: t("display.binary.oneLabel"),
              value: binaryOneColour,
              onChange: onChangeBinaryOneColour,
              onReset: onResetBinaryOneColour,
            },
            {
              label: t("display.binary.zeroLabel"),
              value: binaryZeroColour,
              onChange: onChangeBinaryZeroColour,
              onReset: onResetBinaryZeroColour,
            },
            {
              label: t("display.binary.unusedLabel"),
              value: binaryUnusedColour,
              onChange: onChangeBinaryUnusedColour,
              onReset: onResetBinaryUnusedColour,
            },
          ].map((row) => (
            <div key={row.label} className={flexRowGap2}>
              <ColourPicker label={row.label} value={row.value} onChange={row.onChange} />
              <button
                type="button"
                onClick={row.onReset}
                className={resetButtonIcon}
                title={resetTooltip}
              >
                ↺
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("display.frameEditor.title")}</h3>
          <button type="button" onClick={onResetFrameEditorColours} className={resetButtonSmall}>
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
