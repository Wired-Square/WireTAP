// ui/src/apps/settings/views/DataIOView.tsx

import React from "react";
import { Cable, Plus, Copy, Edit2, Trash2, Star } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import type { IOProfile } from "../stores/settingsStore";
import { getReaderProtocols, isReaderRealtime } from "../../../hooks/useSettings";
import { PrimaryButton } from "../../../components/forms/DialogButtons";
import {
  h2,
  textTertiary,
  cardDefault,
  textPrimary,
  hoverSubtle,
  roundedDefault,
  spaceYLarge,
  spaceYSmall,
  gapSmall,
  badgeSuccess,
  badgePurple,
  badgeWarning,
  badgeNeutral,
  badgeInfo,
  iconButtonHoverDanger,
} from "../../../styles";

type DataIOViewProps = {
  ioProfiles: IOProfile[];
  onAddProfile: () => void;
  onEditProfile: (profile: IOProfile) => void;
  onDeleteProfile: (id: string) => void;
  onDuplicateProfile: (profile: IOProfile) => void;
  defaultReadProfile: string | null;
  onToggleDefaultRead: (profileId: string) => void;
};


const getIOKindLabel = (kind: IOProfile["kind"]) => {
  switch (kind) {
    case "mqtt":
      return "MQTT";
    case "postgres":
      return "PostgreSQL";
    case "gvret_tcp":
      return "GVRET TCP";
    case "gvret_usb":
      return "GVRET USB";
    case "csv_file":
      return "CSV File";
    case "serial":
      return "Serial";
    case "slcan":
      return "slcan";
    case "socketcan":
      return "SocketCAN";
    case "gs_usb":
      return "gs_usb";
    case "modbus_tcp":
      return "Modbus TCP";
    default:
      return kind;
  }
};

const getProtocolBadgeStyle = (protocol: string) => {
  switch (protocol) {
    case "can":
      return badgeSuccess;
    case "serial":
      return badgePurple;
    case "modbus":
      return badgeWarning;
    default:
      return badgeNeutral;
  }
};

const getProtocolLabel = (protocol: string) => {
  switch (protocol) {
    case "can":
      return "CAN";
    case "serial":
      return "Serial";
    case "modbus":
      return "Modbus";
    default:
      return protocol;
  }
};

const SummaryBadge = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <span
    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-[var(--bg-primary)]"
    style={{ color: 'var(--text-secondary)' }}
  >
    <span className="opacity-70">{label}:</span>
    <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{value}</span>
  </span>
);

const renderConnectionSummary = (profile: IOProfile) => {
  const c: any = profile.connection || {};

  if (profile.kind === "mqtt") {
    const host = c.host || "localhost";
    const port = c.port || "1883";
    const formats = c.formats || {};

    const enabledFormats = ["json", "savvycan", "decode"].filter(
      (k) => formats?.[k]?.enabled
    );

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="host" value={host} />
        <SummaryBadge label="port" value={port} />
        {enabledFormats.length > 0 ? (
          <SummaryBadge label="formats" value={enabledFormats.join(",")} />
        ) : (
          <SummaryBadge label="formats" value="none" />
        )}
      </div>
    );
  }

  if (profile.kind === "postgres") {
    const host = c.host || "localhost";
    const port = c.port || "5432";
    const db = c.database || "candor";
    const sourceType = (c.source_type || "can_frame") as string;

    // Friendly labels for source types
    const sourceTypeLabels: Record<string, string> = {
      can_frame: "CAN",
      modbus_frame: "Modbus",
      serial_frame: "Serial",
      serial_raw: "Raw",
    };
    const sourceTypeLabel = sourceTypeLabels[sourceType] || sourceType;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="host" value={host} />
        <SummaryBadge label="port" value={port} />
        <SummaryBadge label="db" value={db} />
        <SummaryBadge label="source" value={sourceTypeLabel} />
        {sourceType === "serial_raw" && c.framing_mode && (
          <SummaryBadge label="framing" value={c.framing_mode} />
        )}
      </div>
    );
  }

  if (profile.kind === "gvret_tcp") {
    const host = c.host || "192.168.1.100";
    const port = c.port || "23";
    const timeout = c.timeout || "5";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="host" value={host} />
        <SummaryBadge label="port" value={port} />
        <SummaryBadge label="timeout" value={`${timeout}s`} />
      </div>
    );
  }

  if (profile.kind === "csv_file") {
    const speed = c.default_speed || "0";
    const speedLabel = speed === "0" ? "No limit" : `${speed}x`;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="speed" value={speedLabel} />
      </div>
    );
  }

  if (profile.kind === "serial") {
    const port = c.port || "(not set)";
    const baud = c.baud_rate || "115200";
    const framing = c.framing_mode || "raw";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="port" value={port} />
        <SummaryBadge label="baud" value={baud} />
        <SummaryBadge label="framing" value={framing} />
      </div>
    );
  }

  if (profile.kind === "slcan") {
    const port = c.port || "(not set)";
    const baudRate = c.baud_rate || 115200;
    const bitrate = c.bitrate || 500000;
    const bitrateLabel = bitrate >= 1000000 ? `${bitrate / 1000000}M` : `${bitrate / 1000}k`;
    const silent = c.silent_mode ?? true;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="port" value={port} />
        {baudRate !== 115200 && <SummaryBadge label="baud" value={baudRate} />}
        <SummaryBadge label="bitrate" value={bitrateLabel} />
        <SummaryBadge label="mode" value={silent ? "silent" : "active"} />
      </div>
    );
  }

  if (profile.kind === "socketcan") {
    const iface = c.interface || "can0";
    const bitrate = c.bitrate ? parseInt(c.bitrate, 10) : null;
    const bitrateLabel = bitrate
      ? (bitrate >= 1000000 ? `${bitrate / 1000000}M` : `${bitrate / 1000}k`)
      : null;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="interface" value={iface} />
        {bitrateLabel ? (
          <SummaryBadge label="bitrate" value={bitrateLabel} />
        ) : (
          <SummaryBadge label="config" value="system" />
        )}
      </div>
    );
  }

  if (profile.kind === "gs_usb") {
    const deviceId = c.device_id || "(not set)";
    const bitrate = c.bitrate || 500000;
    const bitrateLabel = bitrate >= 1000000 ? `${bitrate / 1000000}M` : `${bitrate / 1000}k`;
    const listenOnly = c.listen_only ?? true;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="device" value={deviceId} />
        <SummaryBadge label="bitrate" value={bitrateLabel} />
        <SummaryBadge label="mode" value={listenOnly ? "listen" : "active"} />
      </div>
    );
  }

  if (profile.kind === "gvret_usb") {
    const port = c.port || "(not set)";
    const baudRate = c.baud_rate || "115200";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="port" value={port} />
        <SummaryBadge label="baud" value={baudRate} />
      </div>
    );
  }

  if (profile.kind === "modbus_tcp") {
    const host = c.host || "localhost";
    const port = c.port || "502";
    const unitId = c.unit_id || "1";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="host" value={host} />
        <SummaryBadge label="port" value={port} />
        <SummaryBadge label="unit" value={unitId} />
      </div>
    );
  }

  // Fallback (should be rare)
  const raw = JSON.stringify(profile.connection ?? {}, null, 0);
  return (
    <div className="text-xs font-mono break-all" style={{ color: 'var(--text-secondary)' }}>
      {raw.length > 120 ? raw.slice(0, 120) + "…" : raw}
    </div>
  );
};

export default function DataIOView({
  ioProfiles,
  onAddProfile,
  onEditProfile,
  onDeleteProfile,
  onDuplicateProfile,
  defaultReadProfile,
  onToggleDefaultRead,
}: DataIOViewProps) {
  return (
    <div className={spaceYLarge}>
      <div className="flex items-center justify-between">
        <h2 className={h2}>Data IO Profiles</h2>
        <PrimaryButton onClick={onAddProfile} className="flex items-center gap-1">
          <Plus className={iconMd} />
          Profile
        </PrimaryButton>
      </div>

      {ioProfiles.length === 0 ? (
        <div className={`text-center py-12 ${textTertiary}`}>
          <Cable className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No IO profiles configured</p>
          <p className="text-sm mt-2">Click "Add Profile" to create your first IO profile</p>
        </div>
      ) : (
        <div className={spaceYSmall}>
          {ioProfiles.map((profile) => (
            <div
              key={profile.id}
              className={`flex items-center justify-between p-4 ${cardDefault}`}
            >
              <div className="flex-1">
                <div className={`flex items-center ${gapSmall}`}>
                  <h3 className={`font-medium ${textPrimary}`}>{profile.name}</h3>
                  <span className={badgeInfo}>
                    {getIOKindLabel(profile.kind)}
                  </span>

                  {/* Protocol badge(s) */}
                  {getReaderProtocols(profile.kind, profile.connection).map((protocol) => (
                    <span
                      key={protocol}
                      className={getProtocolBadgeStyle(protocol)}
                    >
                      {getProtocolLabel(protocol)}
                    </span>
                  ))}

                  {/* Realtime indicator */}
                  {!isReaderRealtime(profile.kind) && (
                    <span className={badgeNeutral}>
                      Recorded
                    </span>
                  )}

                  {/* Star icon for default */}
                  <button
                    onClick={() => onToggleDefaultRead(profile.id)}
                    className={`p-1 ${hoverSubtle} rounded transition-colors`}
                    title={
                      defaultReadProfile === profile.id
                        ? "Unset as default"
                        : "Set as default"
                    }
                  >
                    <Star
                      className={`${iconMd} ${
                        defaultReadProfile === profile.id
                          ? "fill-yellow-500 text-yellow-500"
                          : ""
                      }`}
                      style={defaultReadProfile !== profile.id ? { color: 'var(--text-secondary)', opacity: 0.6 } : undefined}
                    />
                  </button>
                </div>

                {/* Connection summary */}
                <div className="mt-2">
                  {renderConnectionSummary(profile)}
                </div>
              </div>

              <div className={`flex items-center ${gapSmall}`}>
                <button
                  onClick={() => onDuplicateProfile(profile)}
                  className={`p-2 ${hoverSubtle} ${roundedDefault} transition-colors`}
                  title="Duplicate profile"
                >
                  <Copy className={iconMd} style={{ color: 'var(--text-secondary)' }} />
                </button>
                <button
                  onClick={() => onEditProfile(profile)}
                  className={`p-2 ${hoverSubtle} ${roundedDefault} transition-colors`}
                  title="Edit profile"
                >
                  <Edit2 className={iconMd} style={{ color: 'var(--text-secondary)' }} />
                </button>
                <button
                  onClick={() => onDeleteProfile(profile.id)}
                  className={iconButtonHoverDanger}
                  title="Delete profile"
                >
                  <Trash2 className={`${iconMd} text-red-600`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
