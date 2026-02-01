// ui/src/dialogs/io-reader-picker/GvretBusConfig.tsx
//
// Bus configuration UI for GVRET devices.
// Shows available buses with toggles to enable/disable and optional bus remapping.
// Also supports protocol selection when used in profile settings.

import { Loader2, AlertCircle, Bus, Lock } from "lucide-react";
import { iconMd, iconXs } from "../../styles/spacing";
import { caption, sectionHeaderText } from "../../styles/typography";
import type { GvretDeviceInfo, BusMapping } from "../../api/io";

// Generic bus names - actual meaning varies by device
const BUS_NAMES: Record<number, string> = {
  0: "Bus 0",
  1: "Bus 1",
  2: "Bus 2",
  3: "Bus 3",
  4: "Bus 4",
};

/** Extended bus mapping with optional protocol field for settings mode */
export interface BusMappingWithProtocol extends BusMapping {
  /** Protocol type (for settings mode) */
  protocol?: 'can' | 'canfd';
}

interface GvretBusConfigProps {
  /** Device info from probing (null while loading or on error) */
  deviceInfo: GvretDeviceInfo | null;
  /** Whether probe is in progress */
  isLoading: boolean;
  /** Error message from probe (null if success) */
  error: string | null;
  /** Current bus mapping configuration */
  busConfig: BusMappingWithProtocol[];
  /** Called when bus config changes */
  onBusConfigChange: (config: BusMappingWithProtocol[]) => void;
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

export default function GvretBusConfig({
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
}: GvretBusConfigProps) {
  // Toggle a bus enabled/disabled
  const toggleBus = (deviceBus: number) => {
    const newConfig = busConfig.map((mapping) =>
      mapping.deviceBus === deviceBus
        ? { ...mapping, enabled: !mapping.enabled }
        : mapping
    );
    onBusConfigChange(newConfig);
  };

  // Change output bus number
  const setOutputBus = (deviceBus: number, outputBus: number) => {
    const newConfig = busConfig.map((mapping) =>
      mapping.deviceBus === deviceBus
        ? { ...mapping, outputBus }
        : mapping
    );
    onBusConfigChange(newConfig);
  };

  // Change protocol for a bus
  const setProtocol = (deviceBus: number, protocol: 'can' | 'canfd') => {
    const newConfig = busConfig.map((mapping) =>
      mapping.deviceBus === deviceBus
        ? { ...mapping, protocol }
        : mapping
    );
    onBusConfigChange(newConfig);
  };

  // Compact wrapper for inline display
  const wrapperClass = compact
    ? "ml-7 mt-1 mb-2 pl-3 border-l-2 border-[color:var(--text-cyan)]"
    : "border-t border-[color:var(--border-default)] px-4 py-3";

  // Loading state
  if (isLoading) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>Probing{profileName ? ` ${profileName}` : ""}...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs text-[color:var(--status-danger-text)]">
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
          <span>Probing{profileName ? ` ${profileName}` : ""}...</span>
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
      <div className="ml-7 mt-1 mb-2 pl-3 border-l-2 border-[color:var(--text-cyan)]">
        <div className="space-y-1">
          {busConfig.map((mapping) => {
            const isDuplicate = usedOutputBuses && mapping.enabled && usedOutputBuses.has(mapping.outputBus);
            return (
              <div
                key={mapping.deviceBus}
                className="flex items-center gap-2 text-xs"
              >
                {/* Enable/disable checkbox */}
                <label className={`flex items-center gap-1.5 ${configLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={mapping.enabled}
                    onChange={() => toggleBus(mapping.deviceBus)}
                    disabled={configLocked}
                    className="w-3 h-3 rounded border-[color:var(--border-default)] text-[color:var(--text-cyan)] focus:ring-cyan-500 bg-[var(--bg-primary)] disabled:cursor-not-allowed"
                  />
                  <span className={configLocked ? "text-[color:var(--text-muted)]" : "text-[color:var(--text-secondary)]"}>
                    {BUS_NAMES[mapping.deviceBus] || `Bus ${mapping.deviceBus}`}
                  </span>
                </label>

                {/* Protocol selector (only show if enabled and showProtocol is true) */}
                {mapping.enabled && showProtocol && (
                  <select
                    value={mapping.protocol || 'can'}
                    onChange={(e) =>
                      setProtocol(mapping.deviceBus, e.target.value as 'can' | 'canfd')
                    }
                    disabled={configLocked}
                    className={`px-1 py-0.5 rounded border text-xs ${
                      configLocked
                        ? "border-[color:var(--border-default)] bg-[var(--hover-bg)] text-[color:var(--text-muted)] cursor-not-allowed"
                        : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
                    } focus:ring-1 focus:ring-cyan-500`}
                  >
                    <option value="can">CAN</option>
                    <option value="canfd">CAN FD</option>
                  </select>
                )}

                {/* Output bus selector (only show if enabled and showOutputBus is true) */}
                {mapping.enabled && showOutputBus && (
                  <div className="flex items-center gap-1">
                    <span className="text-[color:var(--text-muted)]">→</span>
                    <select
                      value={mapping.outputBus}
                      onChange={(e) =>
                        setOutputBus(mapping.deviceBus, parseInt(e.target.value, 10))
                      }
                      disabled={configLocked}
                      className={`px-1 py-0.5 rounded border text-xs ${
                        configLocked
                          ? "border-[color:var(--border-default)] bg-[var(--hover-bg)] text-[color:var(--text-muted)] cursor-not-allowed"
                          : isDuplicate
                          ? "border-[color:var(--text-amber)] bg-[var(--status-warning-bg)] text-[color:var(--text-amber)]"
                          : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
                      } focus:ring-1 focus:ring-cyan-500`}
                    >
                      {Array.from({ length: 8 }, (_, i) => (
                        <option key={i} value={i}>
                          Bus {i}
                        </option>
                      ))}
                    </select>
                    {isDuplicate && !configLocked && (
                      <span className="text-amber-500" title="Another source uses this bus number">⚠</span>
                    )}
                    {configLocked && (
                      <span className="text-[color:var(--text-amber)]" title="Config locked - source in use by multiple sessions">
                        <Lock className={iconXs} />
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {hasDuplicates && (
          <p className="text-[10px] text-[color:var(--text-amber)] mt-1">
            Duplicate bus numbers may cause confusion
          </p>
        )}
      </div>
    );
  }

  // Full mode - separate section display
  return (
    <div className="border-t border-[color:var(--border-default)] px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Bus className={`${iconMd} text-cyan-500`} />
        <span className="text-xs font-medium text-[color:var(--text-secondary)] uppercase tracking-wide">
          {profileName ? `${profileName} - ` : ""}CAN Buses ({enabledCount}/{deviceInfo.bus_count} enabled)
        </span>
      </div>

      <div className="space-y-1">
        {busConfig.map((mapping) => {
          const isDuplicate = usedOutputBuses && mapping.enabled && usedOutputBuses.has(mapping.outputBus);
          return (
            <div
              key={mapping.deviceBus}
              className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                mapping.enabled
                  ? "bg-[var(--bg-surface)]"
                  : "bg-[var(--hover-bg)]/50 opacity-60"
              }`}
            >
              {/* Enable/disable checkbox */}
              <label className={`flex items-center gap-2 flex-1 min-w-0 ${configLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={mapping.enabled}
                  onChange={() => toggleBus(mapping.deviceBus)}
                  disabled={configLocked}
                  className="w-4 h-4 rounded border-[color:var(--border-default)] text-[color:var(--text-cyan)] focus:ring-cyan-500 bg-[var(--bg-primary)] disabled:cursor-not-allowed"
                />
                <span className={configLocked ? "text-sm font-medium text-[color:var(--text-muted)]" : sectionHeaderText}>
                  {BUS_NAMES[mapping.deviceBus] || `Bus ${mapping.deviceBus}`}
                </span>
              </label>

              {/* Protocol selector (only show if enabled and showProtocol is true) */}
              {mapping.enabled && showProtocol && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className={configLocked ? "text-[color:var(--text-muted)]" : "text-[color:var(--text-muted)]"}>Protocol:</span>
                  <select
                    value={mapping.protocol || 'can'}
                    onChange={(e) =>
                      setProtocol(mapping.deviceBus, e.target.value as 'can' | 'canfd')
                    }
                    disabled={configLocked}
                    className={`px-1.5 py-0.5 rounded border text-xs ${
                      configLocked
                        ? "border-[color:var(--border-default)] bg-[var(--hover-bg)] text-[color:var(--text-muted)] cursor-not-allowed"
                        : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
                    } focus:ring-1 focus:ring-cyan-500`}
                  >
                    <option value="can">CAN</option>
                    <option value="canfd">CAN FD</option>
                  </select>
                </div>
              )}

              {/* Output bus selector (only show if enabled and showOutputBus is true) */}
              {mapping.enabled && showOutputBus && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-[color:var(--text-muted)]">→ Output:</span>
                  <select
                    value={mapping.outputBus}
                    onChange={(e) =>
                      setOutputBus(mapping.deviceBus, parseInt(e.target.value, 10))
                    }
                    disabled={configLocked}
                    className={`px-1.5 py-0.5 rounded border text-xs ${
                      configLocked
                        ? "border-[color:var(--border-default)] bg-[var(--hover-bg)] text-[color:var(--text-muted)] cursor-not-allowed"
                        : isDuplicate
                        ? "border-[color:var(--text-amber)] bg-[var(--status-warning-bg)] text-[color:var(--text-amber)]"
                        : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
                    } focus:ring-1 focus:ring-cyan-500`}
                  >
                    {Array.from({ length: 8 }, (_, i) => (
                      <option key={i} value={i}>
                        Bus {i}
                      </option>
                    ))}
                  </select>
                  {isDuplicate && !configLocked && (
                    <span className="text-amber-500" title="Another source uses this bus number">⚠</span>
                  )}
                  {configLocked && (
                    <span className="text-[color:var(--text-amber)]" title="Config locked - source in use by multiple sessions">
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
        <p className="text-xs text-[color:var(--text-amber)] mt-2">
          Configuration locked — this source is in use by multiple sessions.
        </p>
      )}
      {enabledCount === 0 && !configLocked && (
        <p className="text-xs text-[color:var(--text-amber)] mt-2">
          No buses enabled. Enable at least one bus to capture frames.
        </p>
      )}
      {hasDuplicates && !configLocked && (
        <p className="text-xs text-[color:var(--text-amber)] mt-2">
          Warning: Some output bus numbers conflict with other sources
        </p>
      )}
    </div>
  );
}
