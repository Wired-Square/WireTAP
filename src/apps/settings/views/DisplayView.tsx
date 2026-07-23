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
            <h4 className={sectionHeader}>{t("display.themeColours.darkMode")}</h4>
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
          <h4 className={sectionHeader}>{t("display.themeColours.accentTitle")}</h4>
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
          <div className={flexRowGap2}>
            <ColourPicker
              label={t("display.binary.oneLabel")}
              value={binaryOneColour}
              onChange={onChangeBinaryOneColour}
            />
            <button
              type="button"
              onClick={onResetBinaryOneColour}
              className={resetButtonIcon}
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
              className={resetButtonIcon}
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
              className={resetButtonIcon}
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
