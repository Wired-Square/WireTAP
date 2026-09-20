// ui/src/dialogs/io-source-picker/DeviceBusConfig.tsx
//
// Bus configuration UI for multi-bus devices.
// Shows available buses with toggles to enable/disable and optional bus remapping.
// Also supports protocol selection when used in profile settings.

import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle, Bus, Lock } from "lucide-react";
import { iconMd, iconXs } from "../../styles/spacing";
import { caption, sectionHeaderText } from "../../styles/typography";
import type { GvretDeviceInfo, BusMapping, Protocol } from "../../api/io";
import { PROTOCOL_LABELS } from "../../utils/profileTraits";
import { Checkbox, Select } from "../../components/forms";

// Generic bus names - actual meaning varies by device
const BUS_NAMES: Record<number, string> = {
  0: "Bus 0",
  1: "Bus 1",
  2: "Bus 2",
  3: "Bus 3",
  4: "Bus 4",
};

/** Output bus numbers a mapping may be remapped onto. */
const OUTPUT_BUS_COUNT = 8;

interface DeviceBusConfigProps {
  /** Device info from probing (null while loading or on error) */
  deviceInfo: GvretDeviceInfo | null;
  /** Whether probe is in progress */
  isLoading: boolean;
  /** Error message from probe (null if success) */
  error: string | null;
  /** Current bus mapping configuration */
  busConfig: BusMapping[];
  /** Called when bus config changes */
  onBusConfigChange: (config: BusMapping[]) => void;
  /** Profile name for display */
  profileName?: string;
  /** Use compact inline styling (no header, reduced padding) */
  compact?: boolean;
  /** Output bus numbers that are already used by other sources (for duplicate warning) */
  usedOutputBuses?: Set<number>;
  /** Show output bus selector (default: true) - set to false for settings mode */
  showOutputBus?: boolean;
  /** Show protocol selector (default: false) - set to true for settings mode */
  showProtocol?: boolean;
  /** Whether config is locked (source is in use by multiple sessions) */
  configLocked?: boolean;
}

export default function DeviceBusConfig({
  deviceInfo,
  isLoading,
  error,
  busConfig,
  onBusConfigChange,
  profileName,
  compact = false,
  usedOutputBuses,
  showOutputBus = true,
  showProtocol = false,
  configLocked = false,
}: DeviceBusConfigProps) {
  const { t } = useTranslation("dialogs");

  /** Replace one field of one bus's mapping, leaving the rest alone. */
  const updateBus = (deviceBus: number, patch: Partial<BusMapping>) => {
    onBusConfigChange(
      busConfig.map((mapping) =>
        mapping.deviceBus === deviceBus ? { ...mapping, ...patch } : mapping
      )
    );
  };

  /** One row's dropdown, shared by the compact and full layouts. */
  const busSelect = (
    value: number | string,
    onChange: (value: string) => void,
    options: { value: number | string; label: string }[],
    highlight = false,
  ) => (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={configLocked}
      size="xs"
      tone={highlight ? "warning" : undefined}
      className="w-auto"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );

  /**
   * The protocol dropdown for one bus, or null when there is nothing to choose.
   *
   * A bus with one supported protocol (an RS485 FrameLink port, a Modbus TCP
   * source) has its answer already; a dropdown with a single option is worse
   * than none.
   */
  const protocolSelect = (mapping: BusMapping) => {
    const options = mapping.supportedProtocols ?? [];
    if (!showProtocol || options.length < 2) return null;
    return busSelect(
      mapping.protocol ?? options[0],
      (value) => updateBus(mapping.deviceBus, { protocol: value as Protocol }),
      options.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] })),
    );
  };

  /** The output-bus remap dropdown for one bus. */
  const outputBusSelect = (mapping: BusMapping, isDuplicate: boolean) =>
    busSelect(
      mapping.outputBus,
      (value) => updateBus(mapping.deviceBus, { outputBus: parseInt(value, 10) }),
      Array.from({ length: OUTPUT_BUS_COUNT }, (_, i) => ({
        value: i,
        label: t("ioSourcePicker.busConfig.busLabel", { bus: i }),
      })),
      isDuplicate,
    );

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

  // Error state
  if (error) {
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs text-danger">
          <AlertCircle className={`${iconXs} flex-shrink-0`} />
          <span className="truncate">{error}</span>
        </div>
      </div>
    );
  }

  // No device info yet - show loading state (probe should start shortly)
  if (!deviceInfo) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>{profileName ? t("ioSourcePicker.busConfig.probingNamed", { name: profileName }) : t("ioSourcePicker.busConfig.probing")}</span>
        </div>
      </div>
    );
  }

  // Count enabled buses
  const enabledCount = busConfig.filter((m) => m.enabled).length;

  // Check for duplicate output buses (used by other sources)
  const hasDuplicates = usedOutputBuses && busConfig.some(
    (m) => m.enabled && usedOutputBuses.has(m.outputBus)
  );

  // Compact mode - inline display below profile button
  if (compact) {
    return (
      <div className={wrapperClass}>
        <div className="space-y-1">
          {busConfig.map((mapping) => {
            const isDuplicate = usedOutputBuses && mapping.enabled && usedOutputBuses.has(mapping.outputBus);
            const protocol = mapping.enabled ? protocolSelect(mapping) : null;
            return (
              <div
                key={mapping.deviceBus}
                className="flex items-center gap-2 text-xs"
              >
                {/* Enable/disable checkbox */}
                <label className={`flex items-center gap-1.5 ${configLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <Checkbox
                    checked={mapping.enabled}
                    onChange={() => updateBus(mapping.deviceBus, { enabled: !mapping.enabled })}
                    disabled={configLocked}
                    size="sm"
                  />
                  <span className={configLocked ? "text-muted" : "text-secondary"}>
                    {BUS_NAMES[mapping.deviceBus] || t("ioSourcePicker.busConfig.busLabel", { bus: mapping.deviceBus })}
                  </span>
                </label>

                {protocol}

                {/* Output bus selector (only show if enabled and showOutputBus is true) */}
                {mapping.enabled && showOutputBus && (
                  <div className="flex items-center gap-1">
                    <span className="text-muted">→</span>
                    {outputBusSelect(mapping, !!isDuplicate)}
                    {isDuplicate && !configLocked && (
                      <span className="text-warning" title={t("ioSourcePicker.busConfig.duplicateBusTooltip")}>⚠</span>
                    )}
                    {configLocked && (
                      <span className="text-amber" title={t("ioSourcePicker.busConfig.configLockedTooltip")}>
                        <Lock className={iconXs} />
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {enabledCount === 0 && !configLocked && (
          <p className="text-2xs text-amber mt-1">
            {t("ioSourcePicker.busConfig.noBusesEnabled")}
          </p>
        )}
        {hasDuplicates && (
          <p className="text-2xs text-amber mt-1">
            {t("ioSourcePicker.busConfig.duplicateWarning")}
          </p>
        )}
      </div>
    );
  }

  // Full mode - separate section display
  return (
    <div className={wrapperClass}>
      <div className="flex items-center gap-2 mb-2">
        <Bus className={`${iconMd} text-cyan`} />
        <span className="text-xs font-medium text-secondary uppercase tracking-wide">
          {profileName
            ? t("ioSourcePicker.busConfig.namedCanBuses", { name: profileName, enabled: enabledCount, total: deviceInfo.bus_count })
            : t("ioSourcePicker.busConfig.canBuses", { enabled: enabledCount, total: deviceInfo.bus_count })}
        </span>
      </div>

      <div className="space-y-1">
        {busConfig.map((mapping) => {
          const isDuplicate = usedOutputBuses && mapping.enabled && usedOutputBuses.has(mapping.outputBus);
          const protocol = mapping.enabled ? protocolSelect(mapping) : null;
          return (
            <div
              key={mapping.deviceBus}
              className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                mapping.enabled
                  ? "bg-surface"
                  : "bg-hover/50 opacity-60"
              }`}
            >
              {/* Enable/disable checkbox */}
              <label className={`flex items-center gap-2 flex-1 min-w-0 ${configLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <Checkbox
                  checked={mapping.enabled}
                  onChange={() => updateBus(mapping.deviceBus, { enabled: !mapping.enabled })}
                  disabled={configLocked}
                />
                <span className={configLocked ? "text-sm font-medium text-muted" : sectionHeaderText}>
                  {BUS_NAMES[mapping.deviceBus] || `Bus ${mapping.deviceBus}`}
                </span>
              </label>

              {protocol && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted">{t("ioSourcePicker.busConfig.protocol")}</span>
                  {protocol}
                </div>
              )}

              {/* Output bus selector (only show if enabled and showOutputBus is true) */}
              {mapping.enabled && showOutputBus && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted">{t("ioSourcePicker.busConfig.output")}</span>
                  {outputBusSelect(mapping, !!isDuplicate)}
                  {isDuplicate && !configLocked && (
                    <span className="text-warning" title="Another source uses this bus number">⚠</span>
                  )}
                  {configLocked && (
                    <span className="text-amber" title="Config locked - source in use by multiple sessions">
                      <Lock className={iconXs} />
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {configLocked && (
        <p className="text-xs text-amber mt-2">
          {t("ioSourcePicker.busConfig.configLocked")}
        </p>
      )}
      {enabledCount === 0 && !configLocked && (
        <p className="text-xs text-amber mt-2">
          {t("ioSourcePicker.busConfig.noBusesEnabled")}
        </p>
      )}
      {hasDuplicates && !configLocked && (
        <p className="text-xs text-amber mt-2">
          {t("ioSourcePicker.busConfig.duplicateOutputs")}
        </p>
      )}
    </div>
  );
}
