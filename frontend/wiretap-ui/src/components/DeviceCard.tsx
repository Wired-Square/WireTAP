// ui/src/components/DeviceCard.tsx
//
// Shared device card used by WiFi provisioning (BLE only) and firmware
// upgrade (BLE + mDNS/UDP). Renders differently based on transport type.

import { Bluetooth, Globe, Wifi, HardDriveDownload, Plug, Cable } from "lucide-react";
import { cardDefault } from "../styles/cardStyles";
import { textPrimary } from "../styles";
import { iconMd, gapSmall } from "../styles/spacing";
import { PrimaryButton } from "./forms";
import { Badge, SummaryBadge } from "./Badge";

/**
 * Polymorphic device type — works with both provisioning's BleDevice
 * (which has no `transport` field) and upgrade's DiscoveredDevice.
 */
interface DeviceCardDevice {
  name: string;
  id: string;
  rssi?: number | null;
  transport?: "ble" | "udp" | "tcp";
  address?: string | null;
  port?: number | null;
  capabilities?: string[];
}

interface DeviceCardProps {
  device: DeviceCardDevice;
  onConnect: (deviceId: string) => void;
  /** The device ID currently being connected to, or null */
  connectingDeviceId: string | null;
}

/** Map RSSI to a 0-4 bar strength. */
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
    <div className="flex items-end gap-0.5 h-4">
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

export default function DeviceCard({ device, onConnect, connectingDeviceId }: DeviceCardProps) {
  const isThisConnecting = connectingDeviceId === device.id;
  const anyConnecting = connectingDeviceId !== null;
  const isNetwork = device.transport === "udp" || device.transport === "tcp";
  const caps = device.capabilities ?? [];

  return (
    <div className={`${cardDefault} flex items-center justify-between p-4`}>
      <div className="flex-1">
        {/* Row 1: name + badges */}
        <div className={`flex items-center ${gapSmall}`}>
          {isNetwork ? (
            <Globe className={`${iconMd} text-teal-400 shrink-0`} />
          ) : (
            <Bluetooth className={`${iconMd} text-sky-400 shrink-0`} />
          )}
          <h3 className={`font-medium ${textPrimary}`}>{device.name}</h3>
          {caps.length > 0 && (
            <>
              <Badge tone="primary" size="lg" className={caps.includes("wifi-provision") ? "" : "opacity-15"}>
                <Wifi className="w-3 h-3" />
                WiFi
              </Badge>
              <Badge tone="warning" size="lg" className={caps.includes("smp") ? "" : "opacity-15"}>
                <HardDriveDownload className="w-3 h-3" />
                SMP
              </Badge>
              {caps.includes("framelink") && (
                <Badge tone="success" size="lg">
                  <Cable className="w-3 h-3" />
                  FrameLink
                </Badge>
              )}
            </>
          )}
        </div>
        {/* Row 2: metadata summary badges */}
        <div className="mt-2 flex flex-wrap gap-2">
          {isNetwork ? (
            <>
              <SummaryBadge label="addr" value={device.address ?? ""} />
              {device.port != null && <SummaryBadge label="port" value={String(device.port)} />}
            </>
          ) : (
            device.rssi != null && <SummaryBadge label="rssi" value={`${device.rssi} dBm`} />
          )}
        </div>
      </div>

      <div className={`flex items-center ${gapSmall}`}>
        {!isNetwork && <SignalBars rssi={device.rssi} />}
        <PrimaryButton
          onClick={() => onConnect(device.id)}
          disabled={anyConnecting}
          className="w-32"
        >
          <span className="flex items-center justify-center gap-1.5">
            <Plug className={`${iconMd} ${isThisConnecting ? "animate-pulse" : ""}`} />
            {isThisConnecting ? "Connecting..." : "Connect"}
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}
