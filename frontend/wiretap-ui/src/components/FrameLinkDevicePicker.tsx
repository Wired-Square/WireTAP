// src/components/FrameLinkDevicePicker.tsx
//
// Identity picker for FrameLink-bound apps (e.g. Rules), parallel to
// SessionButton for session-bound apps. Renders a compact button showing
// the active device + a status dot, and opens a popover listing every
// remembered FrameLink profile with its liveness state.
//
// Liveness comes from useFrameLinkDeviceLiveness; this component is pure.

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  textPrimary,
  textSecondary,
  textDanger,
  textWarning,
  textSuccess,
} from "../styles/colourTokens";
import type { FrameLinkLiveness } from "../hooks/useFrameLinkDeviceLiveness";
import { Button } from "./Button";
import { MenuItem, Popover, usePopover } from "./Menu";

export interface FramelinkDevice {
  /** Capability device_id (e.g. "WiredFlexLink-9D04"), or `${host}:${port}` fallback. */
  deviceId: string;
  host: string;
  port: number;
  /** Display label (typically the IO profile name). */
  label: string;
}

/**
 * Effective state shown to the user. Combines live mDNS/probe status
 * (from useFrameLinkDeviceLiveness) with the active connection state from
 * the calling app.
 */
export type DeviceVisualState =
  | "connected"
  | "connecting"
  | "error"
  | "connectable"
  | "probing"
  | "missing"
  | "unknown";

export interface FrameLinkDevicePickerProps {
  /** Remembered FrameLink profiles. */
  devices: FramelinkDevice[];
  /** device_id of the device the app is currently bound to (if any). */
  activeDeviceId: string | null;
  /** Current connection state of the active device. */
  activeState?: "connecting" | "connected" | "error" | null;
  /** Liveness map keyed by device_id. */
  livenessByDeviceId: Map<string, FrameLinkLiveness>;
  /** Liveness map keyed by `${host}:${port}` — used when device_id is a fallback. */
  livenessByHostPort: Map<string, FrameLinkLiveness>;
  /** Called when the user selects a device row. */
  onSelect: (device: FramelinkDevice) => void;
  /** Called for each `unknown` / `missing` device when the popover opens. */
  onProbe?: (device: FramelinkDevice) => void;
}

// =============================================================================
// Status dot — shared between button and rows
// =============================================================================

function dotClassFor(state: DeviceVisualState): string {
  switch (state) {
    case "connected":
      return "bg-success-text";
    case "connectable":
      return "bg-info-text";
    case "connecting":
    case "probing":
      return "bg-info-text animate-pulse";
    case "missing":
    case "error":
      return "bg-danger-text";
    case "unknown":
    default:
      return "bg-text-muted";
  }
}

function StatusDot({ state }: { state: DeviceVisualState }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClassFor(state)}`}
      aria-hidden
    />
  );
}

function effectiveState(
  device: FramelinkDevice,
  isActive: boolean,
  activeState: FrameLinkDevicePickerProps["activeState"],
  liveById: Map<string, FrameLinkLiveness>,
  liveByHostPort: Map<string, FrameLinkLiveness>,
): DeviceVisualState {
  if (isActive) {
    if (activeState === "connected") return "connected";
    if (activeState === "connecting") return "connecting";
    if (activeState === "error") return "error";
  }
  const hp = `${device.host}:${device.port}`;
  return (
    liveById.get(device.deviceId) ?? liveByHostPort.get(hp) ?? "unknown"
  );
}

// =============================================================================
// Picker
// =============================================================================

export default function FrameLinkDevicePicker({
  devices,
  activeDeviceId,
  activeState,
  livenessByDeviceId,
  livenessByHostPort,
  onSelect,
  onProbe,
}: FrameLinkDevicePickerProps) {
  const { t } = useTranslation("common");
  const picker = usePopover("listbox");

  const activeDevice = useMemo(
    () => devices.find((d) => d.deviceId === activeDeviceId) ?? null,
    [devices, activeDeviceId],
  );

  // Lazy probe on open: anything we haven't classified as "connectable" yet.
  useEffect(() => {
    if (!picker.open || !onProbe) return;
    for (const d of devices) {
      const hp = `${d.host}:${d.port}`;
      const live =
        livenessByDeviceId.get(d.deviceId) ?? livenessByHostPort.get(hp);
      if (live === "unknown" || live === "missing" || live === undefined) {
        onProbe(d);
      }
    }
    // We intentionally only run when the popover opens — re-running on
    // every liveness map change would re-trigger probes mid-resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker.open]);

  const buttonState: DeviceVisualState = activeDevice
    ? effectiveState(
        activeDevice,
        true,
        activeState ?? null,
        livenessByDeviceId,
        livenessByHostPort,
      )
    : "unknown";

  const buttonLabel = activeDevice?.label ?? t("framelinkPicker.selectDevice");

  return (
    <div className="shrink-0">
      <Button
        {...picker.trigger}
        title={
          activeDevice
            ? activeDevice.label
            : t("framelinkPicker.selectDevice")
        }
      >
        <StatusDot state={buttonState} />
        <span className="max-w-40 truncate">{buttonLabel}</span>
      </Button>

      <Popover {...picker.popover} role="listbox" className="menu min-w-65 max-w-90">
          {devices.length === 0 ? (
            <div className={`px-3 py-2 ${textSecondary}`}>
              {t("framelinkPicker.empty")}
            </div>
          ) : (
            devices.map((d) => {
              const isActive = d.deviceId === activeDeviceId;
              const state = effectiveState(
                d,
                isActive,
                activeState ?? null,
                livenessByDeviceId,
                livenessByHostPort,
              );
              return (
                <MenuItem
                  key={d.deviceId}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(d);
                    picker.close();
                  }}
                >
                  <StatusDot state={state} />
                  <span className={`flex-1 min-w-0 truncate ${textPrimary}`}>
                    {d.label}
                  </span>
                  <span
                    className={`font-mono text-xs text-muted truncate`}
                  >
                    {d.host}:{d.port}
                  </span>
                  <StateSuffix state={state} />
                </MenuItem>
              );
            })
          )}
      </Popover>
    </div>
  );
}

function StateSuffix({ state }: { state: DeviceVisualState }) {
  const { t } = useTranslation("common");
  if (state === "connected") {
    return (
      <span className={`text-xs ${textSuccess}`}>
        {t("framelinkPicker.state.connected")}
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className={`text-xs ${textWarning}`}>
        {t("framelinkPicker.state.connecting")}
      </span>
    );
  }
  if (state === "probing") {
    return (
      <span className={`text-xs ${textWarning}`}>
        {t("framelinkPicker.state.checking")}
      </span>
    );
  }
  if (state === "missing" || state === "error") {
    return (
      <span className={`text-xs ${textDanger}`}>
        {t("framelinkPicker.state.missing")}
      </span>
    );
  }
  if (state === "connectable") {
    return null; // dot alone is enough
  }
  return null;
}
