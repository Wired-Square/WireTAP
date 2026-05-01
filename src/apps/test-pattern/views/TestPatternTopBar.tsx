// src/apps/test-pattern/views/TestPatternTopBar.tsx
//
// Top toolbar for the Test Pattern app. Renders IO session controls via
// AppTopBar, with role/mode/params and start/stop inline.

import { useState, useCallback } from "react";
import { FlaskConical } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconSm } from "../../../styles/spacing";
import { bgSurface, borderDefault, textPrimary, textSecondary } from "../../../styles";
import { badgeColorClass } from "../../../styles/buttonStyles";
import type { IOProfile } from "../../../types/common";
import type { TestMode, TestRole } from "../../../api/testPattern";
import AppTopBar from "../../../components/AppTopBar";

const TEST_MODE_KEYS: { value: TestMode; i18nKey: string }[] = [
  { value: "auto", i18nKey: "auto" },
  { value: "echo", i18nKey: "echo" },
  { value: "throughput", i18nKey: "throughput" },
  { value: "latency", i18nKey: "latency" },
  { value: "reliability", i18nKey: "reliability" },
];

const ROLE_KEYS: { value: TestRole; i18nKey: string }[] = [
  { value: "initiator", i18nKey: "initiator" },
  { value: "responder", i18nKey: "responder" },
];

interface Props {
  // IO session
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;
  sessionId?: string | null;
  multiBusProfiles?: string[];
  isStreaming: boolean;
  isPaused?: boolean;
  isStopped?: boolean;
  ioState?: string | null;
  frameCount?: number;
  totalFrameCount?: number;
  onOpenIoPicker: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onLeave?: () => void;

  // Test config
  role: TestRole;
  mode: TestMode;
  rateHz: number;
  durationSec: number;
  bus: number;
  useFd: boolean;
  useExtended: boolean;
  isRunning: boolean;
  isConnected: boolean;

  // Setters
  onRoleChange: (role: TestRole) => void;
  onModeChange: (mode: TestMode) => void;
  onRateChange: (hz: number) => void;
  onDurationChange: (sec: number) => void;
  onBusChange: (bus: number) => void;
  onFdChange: (fd: boolean) => void;
  onExtendedChange: (ext: boolean) => void;

  // Error
  error?: string | null;
}

export default function TestPatternTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  sessionId,
  multiBusProfiles = [],
  isStreaming,
  isPaused = false,
  isStopped = false,
  ioState,
  frameCount,
  totalFrameCount,
  onOpenIoPicker,
  onPlay,
  onPause,
  onLeave,
  role,
  mode,
  rateHz,
  durationSec,
  bus,
  useFd,
  useExtended,
  isRunning,
  isConnected,
  onRoleChange,
  onModeChange,
  onRateChange,
  onDurationChange,
  onBusChange,
  onFdChange,
  onExtendedChange,
  error = null,
}: Props) {
  const { t } = useTranslation("testPattern");
  const selectClass = `h-7 rounded border px-1.5 text-xs ${bgSurface} ${textPrimary} ${borderDefault}`;
  const inputClass = `h-7 w-16 rounded border px-1.5 text-xs ${bgSurface} ${textPrimary} ${borderDefault}`;

  return (
    <AppTopBar
      icon={FlaskConical}
      iconColour="text-emerald-500"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusProfiles,
        defaultReadProfileId,
        sessionId,
        ioState,
        frameCount,
        totalFrameCount,
        onOpenIoSessionPicker: onOpenIoPicker,
        isStreaming,
        isPaused,
        isStopped,
        onPlay,
        onPause,
        onLeave,
      }}
      actions={
        <>
          {error && (
            <span className="text-xs text-red-400 max-w-[300px] truncate">
              {error}
            </span>
          )}
        </>
      }
    >
      {/* Test controls — shown after IO session, before actions */}
      {isConnected && (
        <>
          <ChevronRight className={`${iconSm} text-[color:var(--text-muted)] shrink-0`} />

          {/* Role (hidden for Auto — always initiator) */}
          {mode !== "auto" && (
            <select
              className={selectClass}
              value={role}
              onChange={(e) => onRoleChange(e.target.value as TestRole)}
              disabled={isRunning}
              title={t("topBar.role")}
            >
              {ROLE_KEYS.map((r) => (
                <option key={r.value} value={r.value}>{t(`roles.${r.i18nKey}`)}</option>
              ))}
            </select>
          )}

          {/* Mode */}
          <select
            className={selectClass}
            value={mode}
            onChange={(e) => onModeChange(e.target.value as TestMode)}
            disabled={isRunning}
            title={t("topBar.testMode")}
          >
            {TEST_MODE_KEYS.map((m) => (
              <option key={m.value} value={m.value}>{m.value === "auto" ? `${t("modes.auto")} (Full Suite)` : t(`modes.${m.i18nKey}`)}</option>
            ))}
          </select>

          {/* Rate (only for non-throughput initiator, hidden for auto) */}
          {role === "initiator" && mode !== "throughput" && mode !== "auto" && (
            <div className="flex items-center gap-1">
              <span className={`text-xs ${textSecondary}`}>{t("topBar.rate")}</span>
              <NumericInput
                className={inputClass}
                value={rateHz}
                onChange={onRateChange}
                disabled={isRunning}
                min={1}
                max={10000}
                title={t("topBar.framesPerSecond")}
              />
            </div>
          )}

          {/* Duration, Bus, FD, Ext — hidden for Auto (uses fixed params) */}
          {mode !== "auto" && (
            <>
              <div className="flex items-center gap-1">
                <span className={`text-xs ${textSecondary}`}>{t("topBar.duration")}</span>
                <NumericInput
                  className={inputClass}
                  value={durationSec}
                  onChange={onDurationChange}
                  disabled={isRunning}
                  min={1}
                  max={86400}
                  title={t("topBar.durationSeconds")}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className={`text-xs ${textSecondary}`}>{t("topBar.bus")}</span>
                <NumericInput
                  className={`${inputClass} w-10`}
                  value={bus}
                  onChange={onBusChange}
                  disabled={isRunning}
                  min={0}
                  max={7}
                  title={t("topBar.busNumber")}
                />
              </div>
              <button
                className={`text-xs px-2 py-0.5 rounded ${
                  useFd
                    ? badgeColorClass('green')
                    : "bg-[var(--bg-surface)] text-[color:var(--text-muted)] border border-[color:var(--border-default)]"
                }`}
                onClick={() => onFdChange(!useFd)}
                disabled={isRunning}
                title={t("topBar.fdMode")}
              >
                FD
              </button>
              <button
                className={`text-xs px-2 py-0.5 rounded ${
                  useExtended
                    ? badgeColorClass('amber')
                    : "bg-[var(--bg-surface)] text-[color:var(--text-muted)] border border-[color:var(--border-default)]"
                }`}
                onClick={() => onExtendedChange(!useExtended)}
                disabled={isRunning}
                title={t("topBar.extendedIds")}
              >
                Ext
              </button>
            </>
          )}

        </>
      )}
    </AppTopBar>
  );
}

/** Number input that uses local state while focused, commits on blur.
 *  Fixes Windows WebView issue where typing is interrupted by re-renders. */
function NumericInput({
  value,
  onChange,
  className,
  disabled,
  min,
  max,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  title?: string;
}) {
  const [localValue, setLocalValue] = useState<string | null>(null);

  const handleFocus = useCallback(() => {
    setLocalValue(String(value));
  }, [value]);

  const handleBlur = useCallback(() => {
    if (localValue !== null) {
      const n = Number(localValue);
      if (!isNaN(n)) onChange(n);
      setLocalValue(null);
    }
  }, [localValue, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <input
      type="number"
      className={className}
      value={localValue ?? value}
      onChange={(e) => setLocalValue(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      min={min}
      max={max}
      title={title}
    />
  );
}
