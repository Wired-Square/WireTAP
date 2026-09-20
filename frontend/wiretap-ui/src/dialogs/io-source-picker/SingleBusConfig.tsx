// ui/src/dialogs/io-source-picker/SingleBusConfig.tsx
//
// Status and bus configuration UI for single-bus devices (slcan, gs_usb, socketcan, serial).
// Shows device status (online/offline) and allows setting a bus number override.
// For serial devices, also shows framing configuration.

import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle, CheckCircle2, Bus, Layers, Lock } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../styles/spacing";
import { caption, sectionHeaderText } from "../../styles/typography";
import type { DeviceProbeResult, FramingEncoding, InterfaceFramingConfig } from "../../api/io";
import { ModbusRtuFields } from "../../components/FramingOptionsPanel";
import { Checkbox, Input, Select } from "../../components/forms";

export type { InterfaceFramingConfig } from "../../api/io";

/** Framing mode keys for dropdown */
const FRAMING_KEYS: { value: FramingEncoding; key: string }[] = [
  { value: "raw", key: "raw" },
  { value: "delimiter", key: "delimiter" },
  { value: "slip", key: "slip" },
  { value: "modbus_rtu", key: "modbus_rtu" },
];

interface SingleBusConfigProps {
  /** Probe result (null while loading or before probe) */
  probeResult: DeviceProbeResult | null;
  /** Whether probe is in progress */
  isLoading: boolean;
  /** Error message from probe (null if success) */
  error: string | null;
  /** Current bus number override (undefined = use default 0) */
  busOverride?: number;
  /** Called when bus override changes */
  onBusOverrideChange: (bus: number | undefined) => void;
  /** Profile name for display */
  profileName?: string;
  /** Use compact inline styling (no header, reduced padding) */
  compact?: boolean;
  /** Bus numbers that are already used by other sources (for duplicate warning) */
  usedBuses?: Set<number>;
  /** Profile kind (e.g., "serial") - shows framing options for serial */
  profileKind?: string;
  /** Current framing config (for serial profiles) */
  framingConfig?: InterfaceFramingConfig;
  /** Called when framing config changes */
  onFramingChange?: (config: InterfaceFramingConfig) => void;
  /** Whether config is locked (source is in use by multiple sessions) */
  configLocked?: boolean;
}

export default function SingleBusConfig({
  probeResult,
  isLoading,
  error,
  busOverride,
  onBusOverrideChange,
  profileName,
  compact = false,
  usedBuses,
  profileKind,
  framingConfig,
  onFramingChange,
  configLocked = false,
}: SingleBusConfigProps) {
  const { t } = useTranslation("dialogs");
  const effectiveBus = busOverride ?? 0;
  const isDuplicate = usedBuses && usedBuses.has(effectiveBus);
  const isSerial = profileKind === "serial";
  const effectiveFraming = framingConfig?.encoding ?? "raw";

  // Compact wrapper for inline display
  const wrapperClass = compact
    ? "ml-7 mt-1 mb-2 pl-3 border-l-2 border-text-cyan"
    : "border-t border-default px-4 py-3";

  // Loading state
  if (isLoading) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>{profileName ? t("ioSourcePicker.busConfig.probingNamed", { name: profileName }) : t("ioSourcePicker.busConfig.probing")}</span>
        </div>
      </div>
    );
  }

  // Error state (probe failed)
  if (error || (probeResult && !probeResult.success)) {
    const errorMsg = error || probeResult?.error || t("ioSourcePicker.singleBusConfig.deviceNotResponding");
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs text-danger">
          <AlertCircle className={`${iconXs} flex-shrink-0`} />
          <span className="truncate">{errorMsg}</span>
        </div>
      </div>
    );
  }

  // No result yet - show loading (probe should start shortly)
  if (!probeResult) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>{profileName ? t("ioSourcePicker.busConfig.probingNamed", { name: profileName }) : t("ioSourcePicker.busConfig.probing")}</span>
        </div>
      </div>
    );
  }

  // Success state - show status and bus selector
  const showDelimiterOptions = isSerial && effectiveFraming === "delimiter";
  const showModbusOptions = isSerial && effectiveFraming === "modbus_rtu";
  const showRawBytesOption = isSerial && effectiveFraming !== "raw";
  const controlSize = compact ? "xs" : "md";
  const patchFraming = (patch: Partial<InterfaceFramingConfig>) =>
    onFramingChange?.({ ...framingConfig, encoding: effectiveFraming, ...patch });

  const busSelect = (
    <Select
      value={effectiveBus}
      onChange={(e) => {
        const val = parseInt(e.target.value, 10);
        onBusOverrideChange(val === 0 ? undefined : val);
      }}
      disabled={configLocked}
      size={controlSize}
      tone={isDuplicate ? "warning" : undefined}
      className="w-auto"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <option key={i} value={i}>
          {t("ioSourcePicker.busConfig.busLabel", { bus: i })}
        </option>
      ))}
    </Select>
  );
  const framingSelect = (
    <Select
      value={effectiveFraming}
      onChange={(e) => onFramingChange?.({ ...framingConfig, encoding: e.target.value as FramingEncoding })}
      disabled={configLocked}
      size={controlSize}
      className="w-auto"
    >
      {FRAMING_KEYS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {t(`ioSourcePicker.singleBusConfig.framingOptions.${opt.key}`)}
        </option>
      ))}
    </Select>
  );
  const delimiterInput = (
    <Input
      type="text"
      value={framingConfig?.delimiterHex ?? "0A"}
      onChange={(e) => patchFraming({ delimiterHex: e.target.value })}
      placeholder={t("ioSourcePicker.singleBusConfig.delimiterPlaceholder")}
      disabled={configLocked}
      size={controlSize}
      mono
      className={compact ? "w-12" : "w-16"}
    />
  );
  const maxLengthInput = (
    <Input
      type="number"
      value={framingConfig?.maxFrameLength ?? 1024}
      onChange={(e) => patchFraming({ maxFrameLength: parseInt(e.target.value, 10) || 1024 })}
      disabled={configLocked}
      size={controlSize}
      className={compact ? "w-16" : "w-20"}
    />
  );
  const modbusFields = (
    <div className="w-full max-w-xs">
      <ModbusRtuFields config={framingConfig ?? {}} onChange={patchFraming} disabled={configLocked} />
    </div>
  );
  const rawBytesCheckbox = (
    <Checkbox
      checked={framingConfig?.emitRawBytes ?? false}
      onChange={(e) => patchFraming({ emitRawBytes: e.target.checked })}
      disabled={configLocked}
      size={compact ? "sm" : undefined}
    />
  );

  if (compact) {
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs">
          <CheckCircle2 className={`${iconXs} text-success flex-shrink-0`} />
          <span className="text-secondary">
            {probeResult.primaryInfo || t("ioSourcePicker.singleBusConfig.online")}
          </span>
          {probeResult.secondaryInfo && (
            <span className="text-muted">
              ({probeResult.secondaryInfo})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs">
          <Bus className={`${iconXs} text-muted flex-shrink-0`} />
          <span className="text-muted">{t("ioSourcePicker.singleBusConfig.bus")}</span>
          {busSelect}
          {isDuplicate && !configLocked && (
            <span className="text-warning" title={t("ioSourcePicker.busConfig.duplicateBusTooltip")}>⚠</span>
          )}
          {configLocked && (
            <span className="text-amber" title={t("ioSourcePicker.busConfig.configLockedTooltip")}>
              <Lock className={iconXs} />
            </span>
          )}

          {/* Framing selector for serial devices */}
          {isSerial && onFramingChange && (
            <>
              <span className="text-muted">|</span>
              <Layers className={`${iconXs} text-muted flex-shrink-0`} />
              {framingSelect}
            </>
          )}
        </div>

        {/* Framing sub-options */}
        {isSerial && onFramingChange && (showDelimiterOptions || showModbusOptions || showRawBytesOption) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-secondary">
            {/* Delimiter options */}
            {showDelimiterOptions && (
              <>
                <label className={`flex items-center gap-1 ${configLocked ? "text-muted" : ""}`}>
                  <span>{t("ioSourcePicker.singleBusConfig.delimiter")}</span>
                  {delimiterInput}
                </label>
                <label className={`flex items-center gap-1 ${configLocked ? "text-muted" : ""}`}>
                  <span>{t("ioSourcePicker.singleBusConfig.max")}</span>
                  {maxLengthInput}
                </label>
              </>
            )}

            {/* Modbus RTU options */}
            {showModbusOptions && modbusFields}

            {/* Raw bytes option (for any framing mode except raw) */}
            {showRawBytesOption && (
              <label className={`flex items-center gap-1 ${configLocked ? "text-muted cursor-not-allowed" : "cursor-pointer"}`}>
                {rawBytesCheckbox}
                <span>{t("ioSourcePicker.singleBusConfig.captureRawBytes")}</span>
              </label>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-default px-4 py-3">
      <div className="flex items-center justify-between">
        <div className={flexRowGap2}>
          <CheckCircle2 className={`${iconMd} text-success`} />
          <span className={sectionHeaderText}>
            {probeResult.primaryInfo || t("ioSourcePicker.singleBusConfig.deviceOnline")}
          </span>
          {probeResult.secondaryInfo && (
            <span className={caption}>
              ({probeResult.secondaryInfo})
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 text-sm">
        <Bus className={`${iconMd} text-muted`} />
        <span className="text-secondary">{t("ioSourcePicker.singleBusConfig.outputBus")}</span>
        {busSelect}
        {isDuplicate && !configLocked && (
          <span className="text-warning text-sm" title={t("ioSourcePicker.busConfig.duplicateBusTooltip")}>
            {t("ioSourcePicker.singleBusConfig.duplicate")}
          </span>
        )}
        {configLocked && (
          <span className="flex items-center gap-1 text-amber" title={t("ioSourcePicker.busConfig.configLockedTooltip")}>
            <Lock className={iconXs} />
          </span>
        )}
      </div>

      {/* Framing selector for serial devices */}
      {isSerial && onFramingChange && (
        <>
          <div className="flex items-center gap-2 mt-2 text-sm">
            <Layers className={`${iconMd} text-muted`} />
            <span className="text-secondary">{t("ioSourcePicker.singleBusConfig.framing")}</span>
            {framingSelect}
          </div>

          {/* Framing sub-options */}
          {(showDelimiterOptions || showModbusOptions || showRawBytesOption) && (
            <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 ml-6 text-sm ${configLocked ? "text-muted" : "text-secondary"}`}>
              {/* Delimiter options */}
              {showDelimiterOptions && (
                <>
                  <label className="flex items-center gap-1.5">
                    <span>{t("ioSourcePicker.singleBusConfig.delimiterHex")}</span>
                    {delimiterInput}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span>{t("ioSourcePicker.singleBusConfig.maxLength")}</span>
                    {maxLengthInput}
                  </label>
                </>
              )}

              {/* Modbus RTU options */}
              {showModbusOptions && modbusFields}

              {/* Raw bytes option (for any framing mode except raw) */}
              {showRawBytesOption && (
                <label className={`flex items-center gap-1.5 ${configLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  {rawBytesCheckbox}
                  <span>{t("ioSourcePicker.singleBusConfig.captureRawBytes")}</span>
                </label>
              )}
            </div>
          )}
        </>
      )}

      <p className={`${caption} mt-2`}>
        {configLocked
          ? t("ioSourcePicker.singleBusConfig.configLockedHint")
          : isSerial
          ? t("ioSourcePicker.singleBusConfig.configureSerial")
          : t("ioSourcePicker.singleBusConfig.tagBus")}
      </p>
    </div>
  );
}
