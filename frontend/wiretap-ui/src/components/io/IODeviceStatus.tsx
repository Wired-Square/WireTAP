// ui/src/apps/settings/components/IODeviceStatus.tsx
//
// Generic component that displays device probe status.
// Shows a green light with info if working, red light with error if not.
// Can be used for slcan, GVRET USB, and other serial-connected devices.

import { useTranslation } from "react-i18next";
import { CircleCheck, CircleX, Loader2, RefreshCw } from "lucide-react";
import { iconMd, iconLg } from "../../styles/spacing";
import { caption } from "../../styles";
import { IconButton } from "../Button";
import { Badge } from "../Badge";
import { Card } from "../Card";
export type DeviceProbeState = "idle" | "probing" | "success" | "error";

export interface DeviceProbeResult {
  /** Whether the probe was successful (device responded) */
  success: boolean;
  /** Primary info to display (e.g., firmware version) */
  primaryInfo?: string | null;
  /** Secondary info to display (e.g., hardware version) */
  secondaryInfo?: string | null;
  /** Whether device supports CAN FD */
  supports_fd?: boolean | null;
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
  primaryLabel,
  secondaryLabel,
  onRefresh,
  probingText,
  successText,
  errorText,
  idleText,
}: Props) {
  const { t } = useTranslation("settings");
  const resolvedPrimaryLabel = primaryLabel ?? t("ioDeviceStatus.firmware");
  const resolvedSecondaryLabel = secondaryLabel ?? t("ioDeviceStatus.hardware");
  const resolvedProbingText = probingText ?? t("ioDeviceStatus.checking");
  const resolvedSuccessText = successText ?? t("ioDeviceStatus.connected");
  const resolvedErrorText = errorText ?? t("ioDeviceStatus.notResponding");
  const resolvedIdleText = idleText ?? t("ioDeviceStatus.selectPort");
  return (
    <Card className="flex items-center gap-2">
      {/* Status indicator */}
      <div className="flex-shrink-0">
        {state === "probing" && (
          <Loader2 className={`${iconLg} text-accent-primary animate-spin`} />
        )}
        {state === "success" && (
          <CircleCheck className={`${iconLg} text-success`} />
        )}
        {state === "error" && (
          <CircleX className={`${iconLg} text-danger`} />
        )}
        {state === "idle" && (
          <div className="w-5 h-5 rounded-full border-2 border-default" />
        )}
      </div>

      {/* Status text */}
      <div className="flex-1 min-w-0">
        {state === "probing" && (
          <span className="text-sm text-muted">
            {resolvedProbingText}
          </span>
        )}
        {state === "success" && result && (
          <div>
            <span className="text-sm font-medium text-green">
              {resolvedSuccessText}
            </span>
            {result.primaryInfo && (
              <span className="text-sm text-muted ml-2">
                {resolvedPrimaryLabel}: {result.primaryInfo}
              </span>
            )}
            {result.secondaryInfo && (
              <span className="text-sm text-muted ml-2">
                {resolvedSecondaryLabel}: {result.secondaryInfo}
              </span>
            )}
            {result.supports_fd === true && (
              <Badge tone="success" size="sm" className="ml-2">{t("ioDeviceStatus.canFd")}</Badge>
            )}
            {result.supports_fd === false && (
              <Badge size="sm" className="ml-2">{t("ioDeviceStatus.can20")}</Badge>
            )}
          </div>
        )}
        {state === "error" && result && (
          <div>
            <span className="text-sm font-medium text-red">
              {resolvedErrorText}
            </span>
            {result.error && (
              <p className={`${caption} mt-0.5 truncate`}>
                {result.error}
              </p>
            )}
          </div>
        )}
        {state === "idle" && (
          <span className="text-sm text-muted">
            {resolvedIdleText}
          </span>
        )}
      </div>

      {/* Refresh button */}
      {onRefresh && (state === "success" || state === "error") && (
        <IconButton
          onClick={onRefresh}
          size="sm"
          title={t("ioDeviceStatus.testConnection")}
        >
          <RefreshCw className={`${iconMd} text-muted`} />
        </IconButton>
      )}
    </Card>
  );
}
