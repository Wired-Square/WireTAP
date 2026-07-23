// ui/src/apps/settings/views/GeneralView.tsx

import { useTranslation } from "react-i18next";
import Select from "../../../components/forms/Select";
import { h2 } from "../../../styles";
import { SUPPORTED_LANGUAGES } from "../../../locales";
import type { DefaultFrameType } from "../../../settings/appSettings";
import {
  SettingSection,
  SettingRow,
  SettingToggleRow,
  BoundedNumberInput,
} from "../components/rows";

type GeneralViewProps = {
  defaultFrameType: DefaultFrameType;
  onChangeDefaultFrameType: (value: DefaultFrameType) => void;
  modbusMaxRegisterErrors: number;
  onChangeModbusMaxRegisterErrors: (value: number) => void;
  preventIdleSleep: boolean;
  onChangePreventIdleSleep: (value: boolean) => void;
  keepDisplayAwake: boolean;
  onChangeKeepDisplayAwake: (value: boolean) => void;
  logLevel: string;
  onChangeLogLevel: (value: string) => void;
  smpPort: number;
  onChangeSmpPort: (value: number) => void;
  language: string;
  onChangeLanguage: (value: string) => void;
  isIOS?: boolean;
};

export default function GeneralView({
  defaultFrameType,
  onChangeDefaultFrameType,
  modbusMaxRegisterErrors,
  onChangeModbusMaxRegisterErrors,
  preventIdleSleep,
  onChangePreventIdleSleep,
  keepDisplayAwake,
  onChangeKeepDisplayAwake,
  logLevel,
  onChangeLogLevel,
  smpPort,
  onChangeSmpPort,
  language,
  onChangeLanguage,
  isIOS = false,
}: GeneralViewProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <h2 className={h2}>{t("general.title")}</h2>

      <SettingRow
        label={t("general.defaultFrameType.label")}
        help={t("general.defaultFrameType.help")}
      >
        <Select
          value={defaultFrameType}
          onChange={(e) => onChangeDefaultFrameType(e.target.value as DefaultFrameType)}
        >
          <option value="can">{t("general.defaultFrameType.options.can")}</option>
          <option value="modbus">{t("general.defaultFrameType.options.modbus")}</option>
          <option value="serial">{t("general.defaultFrameType.options.serial")}</option>
        </Select>
      </SettingRow>

      <SettingSection title={t("general.language.title")}>
        <SettingRow label={t("general.language.label")} help={t("general.language.help")}>
          <Select value={language} onChange={(e) => onChangeLanguage(e.target.value)}>
            {SUPPORTED_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {t(`general.language.options.${code}`, code)}
              </option>
            ))}
          </Select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("general.modbus.title")}>
        <SettingRow
          label={t("general.modbus.maxRegisterErrors.label")}
          help={t("general.modbus.maxRegisterErrors.help")}
        >
          <BoundedNumberInput
            boundKey="modbusMaxRegisterErrors"
            value={modbusMaxRegisterErrors}
            onChange={onChangeModbusMaxRegisterErrors}
            className="w-32"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("general.power.title")}>
        {/* Prevent idle sleep: desktop only (uses keepawake crate) */}
        {!isIOS && (
          <SettingToggleRow
            label={t("general.power.preventIdleSleep.label")}
            help={t("general.power.preventIdleSleep.help")}
            checked={preventIdleSleep}
            onChange={onChangePreventIdleSleep}
          />
        )}
        {/* Keep display awake: all platforms (iOS uses tauri-plugin-keep-screen-on) */}
        <SettingToggleRow
          label={t("general.power.keepDisplayAwake.label")}
          help={t("general.power.keepDisplayAwake.help")}
          checked={keepDisplayAwake}
          onChange={onChangeKeepDisplayAwake}
        />
      </SettingSection>

      <SettingSection title={t("general.diagnostics.title")}>
        <SettingRow
          label={t("general.diagnostics.logLevel.label")}
          help={t("general.diagnostics.logLevel.help")}
        >
          <Select value={logLevel} onChange={(e) => onChangeLogLevel(e.target.value)}>
            <option value="off">{t("general.diagnostics.logLevel.options.off")}</option>
            <option value="info">{t("general.diagnostics.logLevel.options.info")}</option>
            <option value="debug">{t("general.diagnostics.logLevel.options.debug")}</option>
            <option value="verbose">{t("general.diagnostics.logLevel.options.verbose")}</option>
          </Select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("general.networking.title")}>
        <SettingRow
          label={t("general.networking.smpPort.label")}
          help={t("general.networking.smpPort.help")}
        >
          <BoundedNumberInput
            boundKey="smpPort"
            value={smpPort}
            onChange={onChangeSmpPort}
            className="w-32"
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
