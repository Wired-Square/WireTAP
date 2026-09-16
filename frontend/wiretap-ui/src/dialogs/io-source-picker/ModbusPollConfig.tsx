// ui/src/dialogs/io-source-picker/ModbusPollConfig.tsx
//
// What a Modbus session should poll, when you have no decoder for the device.
//
// Modbus is the one source whose content the client chooses: a session with no
// poll groups reads nothing at all — the source refuses to start, ends its
// stream as `no_polls`, and never opens a connection. Until this existed the
// only way to author a poll set was a catalogue, which only the Decoder loads,
// so every Modbus session started from Discovery was silent by construction.
//
// A range is the catalogue-free way to say it: "read these addresses this
// often". Rust already builds the poll groups (`modbus_polls_from_ranges`,
// chunking and clamping to the protocol maximum for the register type); this is
// the entry point it never had.
//
// Session-level, not per-source, because `modbusPollsJson` is: the backend
// injects one poll plan into every modbus_tcp source in the session. A per-row
// control would promise a per-device plan the session cannot keep.

import { useTranslation } from "react-i18next";
import { borderDefault, textMuted } from "../../styles";
import CheckboxField from "../../components/forms/CheckboxField";
import { FieldRow, NumberField, SelectField, registerTypeOptions } from "../../components/modbus/ModbusFields";
import { MODBUS_SCAN_BOUNDS } from "../../components/modbus/modbusScanDefaults";
import type { ModbusRangeSpec, ModbusRegisterType } from "../../api/io";

/** The picker's poll settings. `enabled` off means "don't poll". */
export interface ModbusPollConfigState {
  enabled: boolean;
  registerType: ModbusRegisterType;
  start: number;
  end: number;
  intervalMs: number;
}

/**
 * Off by default, and deliberately: enabling it puts continuous traffic on
 * someone's device. A silent session is still useful — the scan tools read the
 * device address off the profile, so they work whether or not it polls.
 */
export const DEFAULT_MODBUS_POLL_CONFIG: ModbusPollConfigState = {
  enabled: false,
  registerType: "holding",
  start: 0,
  end: 99,
  intervalMs: 1000,
};

/**
 * The spec to send, or null when this session should not poll.
 *
 * `unitId` comes from the profile rather than the form: the poll loop sets the
 * slave per request, so a spec that omits it silently reads unit 1 no matter
 * which unit the profile names — and the frames would then be bussed under the
 * wrong address too.
 */
export function pollSpecFor(
  config: ModbusPollConfigState | undefined,
  unitId?: number
): ModbusRangeSpec | null {
  if (!config?.enabled || config.start > config.end) return null;
  return {
    ranges: [{ register_type: config.registerType, start: config.start, end: config.end }],
    interval_ms: config.intervalMs,
    ...(unitId !== undefined && { device_address: unitId }),
  };
}

type Props = {
  config: ModbusPollConfigState;
  onChange: (next: ModbusPollConfigState) => void;
  /** Locked while the source is already in use by another session. */
  disabled?: boolean;
};

export default function ModbusPollConfig({ config, onChange, disabled }: Props) {
  const { t } = useTranslation("dialogs");
  const set = (patch: Partial<ModbusPollConfigState>) => onChange({ ...config, ...patch });

  // One rule, one place: invalid is exactly "enabled but there is no spec to
  // send", so the warning cannot drift from what the picker actually does.
  const invalid = config.enabled && !pollSpecFor(config);
  const count = Math.max(0, config.end - config.start + 1);

  return (
    <div className={`mt-2 pt-2 border-t ${borderDefault} space-y-2 text-xs`}>
      <CheckboxField
        label={t("modbusPoll.enable")}
        checked={config.enabled}
        onChange={(enabled) => set({ enabled })}
        disabled={disabled}
      />

      {config.enabled ? (
        <>
          <FieldRow>
            <SelectField
              label={t("modbusPoll.registerType")}
              value={config.registerType}
              onChange={(registerType) => set({ registerType })}
              options={registerTypeOptions(t)}
              disabled={disabled}
            />
            <NumberField
              label={t("modbusPoll.start")}
              value={config.start}
              onChange={(start) => set({ start })}
              min={MODBUS_SCAN_BOUNDS.register.min}
              max={MODBUS_SCAN_BOUNDS.register.max}
              disabled={disabled}
            />
            <NumberField
              label={t("modbusPoll.end")}
              value={config.end}
              onChange={(end) => set({ end })}
              min={MODBUS_SCAN_BOUNDS.register.min}
              max={MODBUS_SCAN_BOUNDS.register.max}
              disabled={disabled}
            />
            <NumberField
              label={t("modbusPoll.intervalMs")}
              value={config.intervalMs}
              onChange={(intervalMs) => set({ intervalMs })}
              min={MODBUS_SCAN_BOUNDS.pollIntervalMs.min}
              max={MODBUS_SCAN_BOUNDS.pollIntervalMs.max}
              disabled={disabled}
            />
          </FieldRow>
          <p className={invalid ? "text-amber-500" : textMuted}>
            {invalid
              ? t("modbusPoll.rangeInvalid")
              : t("modbusPoll.summary", { count, interval: config.intervalMs })}
          </p>
        </>
      ) : (
        <p className={textMuted}>{t("modbusPoll.disabledHint")}</p>
      )}
    </div>
  );
}
