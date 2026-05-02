// ui/src/components/MergedDeviceCard.tsx
//
// One card per physical device, fed by a MergedDevice (BLE + mDNS rolled up
// by name). The four capability badges encode discovery state on two layers:
//   • edge (ring)   = capability advertised over BLE
//   • centre (fill) = capability confirmed via mDNS (i.e. live on the network)
// Metadata bubbles (rssi / addr / ports) are ringed in the colour of their
// transport. Two connect buttons (BLE blue, IP purple) light up when their
// transport is present.

import { Bluetooth, Globe, Wifi, HardDriveDownload, Cable, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cardDefault } from "../styles/cardStyles";
import {
  textPrimary,
  textSecondary,
  textInfo,
  textWarning,
  textSuccess,
  textPurple,
  bgInfo,
  bgWarning,
  bgSuccess,
  bgPurple,
} from "../styles";

// Tailwind ring utility needs ring-{color}; the border-{color} status tokens
// only set border-color, not --tw-ring-color. Define the ring variants here.
const ringInfo = "ring-[color:var(--status-info-border)]";
const ringWarning = "ring-[color:var(--status-warning-border)]";
const ringSuccess = "ring-[color:var(--status-success-border)]";
const ringPurple = "ring-[color:var(--status-purple-border)]";
import { iconMd, gapSmall } from "../styles/spacing";
import type { MergedDevice } from "../apps/devices/utils/mergedDevices";
import { bleHasCap, preferredAddress } from "../apps/devices/utils/mergedDevices";

export type ConnectVia = "ble" | "ip";

interface MergedDeviceCardProps {
  device: MergedDevice;
  onConnect: (device: MergedDevice, via: ConnectVia) => void;
  /** Identifies which card+button is mid-connect, or null. */
  connecting: { name: string; via: ConnectVia } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rssiToStrength(rssi: number | null | undefined): number {
  if (rssi == null) return 0;
  if (rssi >= -50) return 4;
  if (rssi >= -60) return 3;
  if (rssi >= -70) return 2;
  if (rssi >= -80) return 1;
  return 0;
}

function SignalBars({ rssi }: { rssi: number | null | undefined }) {
  const strength = rssiToStrength(rssi);
  return (
    <div className="flex items-end gap-0.5 h-4" aria-hidden="true">
      {[1, 2, 3, 4].map((bar) => (
        <div
          key={bar}
          className={`w-1 rounded-sm transition-colors ${
            bar <= strength ? "bg-green-500" : "bg-[var(--border-default)]"
          }`}
          style={{ height: `${bar * 25}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capability badge — two-layer encoding
// ---------------------------------------------------------------------------

type BadgeColour = "info" | "warning" | "success" | "purple";

const BADGE_COLOUR_CLASSES: Record<BadgeColour, { bg: string; text: string }> = {
  info: { bg: bgInfo, text: textInfo },
  warning: { bg: bgWarning, text: textWarning },
  success: { bg: bgSuccess, text: textSuccess },
  purple: { bg: bgPurple, text: textPurple },
};

function CapabilityBadge({
  label,
  icon,
  colour,
  edge,
  centre,
}: {
  label: string;
  icon: React.ReactNode;
  colour: BadgeColour;
  edge: boolean;     // BLE-advertised → blue ring
  centre: boolean;   // mDNS-confirmed → filled in the badge's own colour
}) {
  const { bg, text } = BADGE_COLOUR_CLASSES[colour];
  const base = "inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium";
  // Edge always reads blue when asserted — it represents "BLE says this exists",
  // independent of the capability's own colour family.

  let classes: string;
  if (!edge && !centre) {
    classes = `${base} ${bg} ${text} opacity-15`;
  } else if (edge && !centre) {
    classes = `${base} ${text} ring-1 ${ringInfo} opacity-70`;
  } else if (!edge && centre) {
    classes = `${base} ${bg} ${text}`;
  } else {
    classes = `${base} ${bg} ${text} ring-1 ${ringInfo}`;
  }

  return (
    <span className={classes}>
      {icon}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Metadata bubble — coloured edge, neutral fill
// ---------------------------------------------------------------------------

function MetaBubble({
  label,
  value,
  ringClass,
}: {
  label: string;
  value: string;
  ringClass: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-[var(--bg-primary)] ${textSecondary} ring-1 ${ringClass}`}
    >
      <span className="opacity-70">{label}:</span>
      <span className={`font-mono ${textPrimary}`}>{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connect button — colour-coded per transport, lit when its data is present
// ---------------------------------------------------------------------------

const CONNECT_BUTTON_BASE =
  "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded border transition-colors w-32 justify-center disabled:cursor-not-allowed";

function ConnectButton({
  via,
  enabled,
  busy,
  anyBusy,
  onClick,
}: {
  via: ConnectVia;
  enabled: boolean;
  busy: boolean;
  anyBusy: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("devices");
  // BLE = blue, IP = purple.
  const lit =
    via === "ble"
      ? `${bgInfo} ${textInfo} border-[color:var(--status-info-border)] ring-1 ${ringInfo} hover:brightness-110`
      : `${bgPurple} ${textPurple} border-[color:var(--status-purple-border)] ring-1 ${ringPurple} hover:brightness-110`;
  const dim = `${textSecondary} border-[color:var(--border-default)] opacity-40`;

  const Icon = via === "ble" ? Bluetooth : Globe;
  const aria = via === "ble" ? t("card.connectViaBle") : t("card.connectViaIp");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled || anyBusy}
      aria-label={aria}
      title={aria}
      className={`${CONNECT_BUTTON_BASE} ${enabled ? lit : dim}`}
    >
      {busy ? (
        <Plug className={`${iconMd} animate-pulse`} />
      ) : (
        <Icon className={iconMd} />
      )}
      {busy ? t("card.connecting") : t("card.connect")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export default function MergedDeviceCard({ device, onConnect, connecting }: MergedDeviceCardProps) {
  const { t } = useTranslation("devices");
  const wifiEdge = bleHasCap(device, "wifi-provision");
  const wifiCentre = device.smp != null || device.framelink != null; // proves WiFi joined
  const smpEdge = bleHasCap(device, "smp");
  const smpCentre = device.smp != null;
  const flEdge = bleHasCap(device, "framelink");
  const flCentre = device.framelink != null;

  const hasIp = device.framelink != null || device.smp != null;
  const hasBle = device.ble != null;

  const anyBusy = connecting != null;
  const bleBusy = connecting?.name === device.name && connecting.via === "ble";
  const ipBusy = connecting?.name === device.name && connecting.via === "ip";

  const addr = preferredAddress(device);

  return (
    <div className={`${cardDefault} flex items-center justify-between p-4`}>
      <div className="flex-1 min-w-0">
        {/* Row 1: name + capability badges */}
        <div className={`flex items-center flex-wrap ${gapSmall}`}>
          <h3 className={`font-medium ${textPrimary} truncate`}>{device.name}</h3>

          <CapabilityBadge
            label={t("card.badges.ble")}
            icon={<Bluetooth className="w-3 h-3" />}
            colour="info"
            edge={hasBle}
            centre={hasBle}
          />
          <CapabilityBadge
            label={t("card.badges.wifi")}
            icon={<Wifi className="w-3 h-3" />}
            colour="purple"
            edge={wifiEdge}
            centre={wifiCentre}
          />
          <CapabilityBadge
            label={t("card.badges.smp")}
            icon={<HardDriveDownload className="w-3 h-3" />}
            colour="warning"
            edge={smpEdge}
            centre={smpCentre}
          />
          <CapabilityBadge
            label={t("card.badges.frameLink")}
            icon={<Cable className="w-3 h-3" />}
            colour="success"
            edge={flEdge}
            centre={flCentre}
          />
        </div>

        {/* Row 2: metadata bubbles (only those with data) */}
        <div className="mt-2 flex flex-wrap gap-2">
          {device.ble?.rssi != null && (
            <MetaBubble
              label={t("card.meta.rssi")}
              value={t("card.meta.rssiValue", { rssi: device.ble.rssi })}
              ringClass={ringInfo}
            />
          )}
          {addr && (
            <MetaBubble label={t("card.meta.addr")} value={addr} ringClass={ringPurple} />
          )}
          {device.smp && (
            <MetaBubble
              label={t("card.meta.smpPort")}
              value={String(device.smp.port)}
              ringClass={ringWarning}
            />
          )}
          {device.framelink && (
            <MetaBubble
              label={t("card.meta.frameLinkPort")}
              value={String(device.framelink.port)}
              ringClass={ringSuccess}
            />
          )}
        </div>
      </div>

      <div className={`flex items-center ${gapSmall} ml-4`}>
        {hasBle && <SignalBars rssi={device.ble?.rssi} />}
        <div className="flex flex-col gap-2">
          <ConnectButton
            via="ble"
            enabled={hasBle}
            busy={bleBusy}
            anyBusy={anyBusy}
            onClick={() => onConnect(device, "ble")}
          />
          <ConnectButton
            via="ip"
            enabled={hasIp}
            busy={ipBusy}
            anyBusy={anyBusy}
            onClick={() => onConnect(device, "ip")}
          />
        </div>
      </div>
    </div>
  );
}
