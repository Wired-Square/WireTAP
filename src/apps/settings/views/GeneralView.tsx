// ui/src/apps/settings/views/GeneralView.tsx

import { useTranslation } from "react-i18next";
import Input from "../../../components/forms/Input";
import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";
import { textPrimary } from "../../../styles/colourTokens";
import { SUPPORTED_LANGUAGES } from "../../../locales";

type DefaultFrameType = "can" | "modbus" | "serial";

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
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
        {t("general.title")}
      </h2>

      <div className="space-y-2">
        <label className={labelDefault}>{t("general.defaultFrameType.label")}</label>
        <p className={helpText}>{t("general.defaultFrameType.help")}</p>
        <Select
          value={defaultFrameType}
          onChange={(e) =>
            onChangeDefaultFrameType(e.target.value as DefaultFrameType)
          }
        >
          <option value="can">{t("general.defaultFrameType.options.can")}</option>
          <option value="modbus">{t("general.defaultFrameType.options.modbus")}</option>
          <option value="serial">{t("general.defaultFrameType.options.serial")}</option>
        </Select>
      </div>

      {/* Language Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>
          {t("general.language.title")}
        </h3>
        <div className="space-y-2">
          <label className={labelDefault}>{t("general.language.label")}</label>
          <p className={helpText}>{t("general.language.help")}</p>
          <Select
            value={language}
            onChange={(e) => onChangeLanguage(e.target.value)}
          >
            {SUPPORTED_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {t(`general.language.options.${code}`, code)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Modbus Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>{t("general.modbus.title")}</h3>
        <div className="space-y-2">
          <label className={labelDefault}>
            {t("general.modbus.maxRegisterErrors.label")}
          </label>
          <p className={helpText}>
            {t("general.modbus.maxRegisterErrors.help")}
          </p>
          <Input
            type="number"
            min={0}
            value={modbusMaxRegisterErrors}
            onChange={(e) =>
              onChangeModbusMaxRegisterErrors(
                Math.max(0, parseInt(e.target.value) || 0),
              )
            }
            className="w-32"
          />
        </div>
      </div>

      {/* Power Management Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>
          {t("general.power.title")}
        </h3>
        <div className="space-y-4">
          {/* Prevent idle sleep: desktop only (uses keepawake crate) */}
          {!isIOS && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={preventIdleSleep}
                onChange={(e) => onChangePreventIdleSleep(e.target.checked)}
                className="mt-1"
              />
              <div>
                <span className={labelDefault}>
                  {t("general.power.preventIdleSleep.label")}
                </span>
                <p className={helpText}>
                  {t("general.power.preventIdleSleep.help")}
                </p>
              </div>
            </label>
          )}

          {/* Keep display awake: all platforms (iOS uses tauri-plugin-keep-screen-on) */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={keepDisplayAwake}
              onChange={(e) => onChangeKeepDisplayAwake(e.target.checked)}
              className="mt-1"
            />
            <div>
              <span className={labelDefault}>
                {t("general.power.keepDisplayAwake.label")}
              </span>
              <p className={helpText}>
                {t("general.power.keepDisplayAwake.help")}
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Diagnostics Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>
          {t("general.diagnostics.title")}
        </h3>
        <div className="space-y-2">
          <label className={labelDefault}>{t("general.diagnostics.logLevel.label")}</label>
          <p className={helpText}>
            {t("general.diagnostics.logLevel.help")}
          </p>
          <Select
            value={logLevel}
            onChange={(e) => onChangeLogLevel(e.target.value)}
          >
            <option value="off">{t("general.diagnostics.logLevel.options.off")}</option>
            <option value="info">{t("general.diagnostics.logLevel.options.info")}</option>
            <option value="debug">{t("general.diagnostics.logLevel.options.debug")}</option>
            <option value="verbose">{t("general.diagnostics.logLevel.options.verbose")}</option>
          </Select>
        </div>
      </div>

      {/* Networking Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>
          {t("general.networking.title")}
        </h3>
        <div className="space-y-2">
          <label className={labelDefault}>{t("general.networking.smpPort.label")}</label>
          <p className={helpText}>
            {t("general.networking.smpPort.help")}
          </p>
          <Input
            type="number"
            value={smpPort}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1 && v <= 65535) onChangeSmpPort(v);
            }}
            min={1}
            max={65535}
            className="w-32"
          />
        </div>
      </div>
    </div>
  );
}
