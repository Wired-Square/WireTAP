// ui/src/components/MergedDeviceCard.tsx
//
// One card per physical device, fed by a MergedDevice (BLE + mDNS rolled up
// by name). The four capability badges encode discovery state on two layers:
//   • edge (ring)   = capability advertised over BLE
//   • centre (fill) = capability confirmed via mDNS (i.e. live on the network)
// Metadata badges (rssi / addr / ports) are outlined in the colour of their
// transport. Two connect buttons (BLE blue, IP purple) light up when their
// transport is present.

import { Bluetooth, Globe, Wifi, HardDriveDownload, Cable, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { textPrimary } from "../styles";
import { iconMd, gapSmall } from "../styles/spacing";
import type { MergedDevice } from "../apps/devices/utils/mergedDevices";
import { bleHasCap, preferredAddress } from "../apps/devices/utils/mergedDevices";
import { Button } from "./Button";
import { Badge, SummaryBadge, type BadgeTone } from "./Badge";
import { Card } from "./Card";

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
            bar <= strength ? "bg-green-500" : "bg-border-default"
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

// The edge always reads blue when asserted — it represents "BLE says this
// exists", independent of the capability's own colour family.
const BLE_RING = "ring-1 ring-info";

function CapabilityBadge({
  label,
  icon,
  tone,
  edge,
  centre,
}: {
  label: string;
  icon: React.ReactNode;
  tone: BadgeTone;
  edge: boolean;     // BLE-advertised → blue ring
  centre: boolean;   // mDNS-confirmed → filled in the badge's own colour
}) {
  const layers =
    !edge && !centre ? "opacity-15" :
    edge && !centre ? `bg-transparent ${BLE_RING} opacity-70` :
    !edge && centre ? "" :
    BLE_RING;
  return (
    <Badge tone={tone} size="lg" className={layers}>
      {icon}
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Connect button — colour-coded per transport, lit when its data is present
// ---------------------------------------------------------------------------

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
  const Icon = via === "ble" ? Bluetooth : Globe;
  const aria = via === "ble" ? t("card.connectViaBle") : t("card.connectViaIp");

  // BLE = blue, IP = purple; lit as a tonal button when its data is present.
  return (
    <Button
      onClick={onClick}
      disabled={!enabled || anyBusy}
      aria-label={aria}
      title={aria}
      variant={enabled ? "tonal" : "outline"}
      tone={via === "ble" ? "primary" : "purple"}
      size="lg"
      className="w-32"
    >
      {busy ? (
        <Plug className={`${iconMd} animate-pulse`} />
      ) : (
        <Icon className={iconMd} />
      )}
      {busy ? t("card.connecting") : t("card.connect")}
    </Button>
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
    <Card padding="lg" className="flex items-center justify-between">
      <div className="flex-1 min-w-0">
        {/* Row 1: name + capability badges */}
        <div className={`flex items-center flex-wrap ${gapSmall}`}>
          <h3 className={`font-medium ${textPrimary} truncate`}>{device.name}</h3>

          <CapabilityBadge
            label={t("card.badges.ble")}
            icon={<Bluetooth className="w-3 h-3" />}
            tone="primary"
            edge={hasBle}
            centre={hasBle}
          />
          <CapabilityBadge
            label={t("card.badges.wifi")}
            icon={<Wifi className="w-3 h-3" />}
            tone="purple"
            edge={wifiEdge}
            centre={wifiCentre}
          />
          <CapabilityBadge
            label={t("card.badges.smp")}
            icon={<HardDriveDownload className="w-3 h-3" />}
            tone="warning"
            edge={smpEdge}
            centre={smpCentre}
          />
          <CapabilityBadge
            label={t("card.badges.frameLink")}
            icon={<Cable className="w-3 h-3" />}
            tone="success"
            edge={flEdge}
            centre={flCentre}
          />
        </div>

        {/* Row 2: metadata bubbles (only those with data) */}
        <div className="mt-2 flex flex-wrap gap-2">
          {device.ble?.rssi != null && (
            <SummaryBadge
              label={t("card.meta.rssi")}
              value={t("card.meta.rssiValue", { rssi: device.ble.rssi })}
              tone="primary"
              variant="outline"
            />
          )}
          {addr && (
            <SummaryBadge label={t("card.meta.addr")} value={addr} tone="purple" variant="outline" />
          )}
          {device.smp && (
            <SummaryBadge
              label={t("card.meta.smpPort")}
              value={String(device.smp.port)}
              tone="warning"
              variant="outline"
            />
          )}
          {device.framelink && (
            <SummaryBadge
              label={t("card.meta.frameLinkPort")}
              value={String(device.framelink.port)}
              tone="success"
              variant="outline"
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
    </Card>
  );
}
