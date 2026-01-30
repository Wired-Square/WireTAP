// ui/src/apps/settings/components/IODeviceStatus.tsx
//
// Generic component that displays device probe status.
// Shows a green light with info if working, red light with error if not.
// Can be used for slcan, GVRET USB, and other serial-connected devices.

import { CircleCheck, CircleX, Loader2, RefreshCw } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, iconButtonHoverSmall } from "../../../styles";

export type DeviceProbeState = "idle" | "probing" | "success" | "error";

export interface DeviceProbeResult {
  /** Whether the probe was successful (device responded) */
  success: boolean;
  /** Primary info to display (e.g., firmware version) */
  primaryInfo?: string | null;
  /** Secondary info to display (e.g., hardware version) */
  secondaryInfo?: string | null;
  /** Error message (if probe failed) */
  error?: string | null;
}

interface Props {
  /** Current probe state */
  state: DeviceProbeState;
  /** Probe result (if any) */
  result?: DeviceProbeResult | null;
  /** Label for the primary info (e.g., "Firmware") */
  primaryLabel?: string;
  /** Label for the secondary info (e.g., "Hardware") */
  secondaryLabel?: string;
  /** Callback when refresh is clicked */
  onRefresh?: () => void;
  /** Text to show when probing */
  probingText?: string;
  /** Text to show on success */
  successText?: string;
  /** Text to show on error */
  errorText?: string;
  /** Text to show when idle */
  idleText?: string;
}

export default function IODeviceStatus({
  state,
  result,
  primaryLabel = "Firmware",
  secondaryLabel = "Hardware",
  onRefresh,
  probingText = "Checking device...",
  successText = "Device connected",
  errorText = "Device not responding",
  idleText = "Select a port to check device",
}: Props) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--bg-surface)] border border-[color:var(--border-default)]">
      {/* Status indicator */}
      <div className="flex-shrink-0">
        {state === "probing" && (
          <Loader2 className={`${iconLg} text-blue-500 animate-spin`} />
        )}
        {state === "success" && (
          <CircleCheck className={`${iconLg} text-green-500`} />
        )}
        {state === "error" && (
          <CircleX className={`${iconLg} text-red-500`} />
        )}
        {state === "idle" && (
          <div className="w-5 h-5 rounded-full border-2 border-[color:var(--border-default)]" />
        )}
      </div>

      {/* Status text */}
      <div className="flex-1 min-w-0">
        {state === "probing" && (
          <span className="text-sm text-[color:var(--text-muted)]">
            {probingText}
          </span>
        )}
        {state === "success" && result && (
          <div>
            <span className="text-sm font-medium text-[color:var(--text-green)]">
              {successText}
            </span>
            {result.primaryInfo && (
              <span className="text-sm text-[color:var(--text-muted)] ml-2">
                {primaryLabel}: {result.primaryInfo}
              </span>
            )}
            {result.secondaryInfo && (
              <span className="text-sm text-[color:var(--text-muted)] ml-2">
                {secondaryLabel}: {result.secondaryInfo}
              </span>
            )}
          </div>
        )}
        {state === "error" && result && (
          <div>
            <span className="text-sm font-medium text-[color:var(--text-red)]">
              {errorText}
            </span>
            {result.error && (
              <p className={`${caption} mt-0.5 truncate`}>
                {result.error}
              </p>
            )}
          </div>
        )}
        {state === "idle" && (
          <span className="text-sm text-[color:var(--text-muted)]">
            {idleText}
          </span>
        )}
      </div>

      {/* Refresh button */}
      {onRefresh && (state === "success" || state === "error") && (
        <button
          type="button"
          onClick={onRefresh}
          className={iconButtonHoverSmall}
          title="Probe device again"
        >
          <RefreshCw className={`${iconMd} text-[color:var(--text-muted)]`} />
        </button>
      )}
    </div>
  );
}
