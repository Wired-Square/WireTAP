// ui/src/apps/settings/views/DataIOView.tsx

import React from "react";
import { Cable, Plus, Copy, Edit2, Trash2, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { iconMd } from "../../../styles/spacing";
import type { IOProfile } from "../stores/settingsStore";
import { getReaderProtocols, isReaderRealtime } from "../../../hooks/useSettings";
import { getIOKindLabel } from "../../../utils/ioKindLabel";
import { PrimaryButton } from "../../../components/forms/DialogButtons";
import {
  h2,
  textTertiary,
  cardDefault,
  textPrimary,
  textSecondary,
  hoverSubtle,
  roundedDefault,
  spaceYLarge,
  spaceYSmall,
  gapSmall,
  badgeSuccess,
  badgePurple,
  badgeWarning,
  badgeNeutral,
  badgeDanger,
  badgeInfo,
  badgeCyan,
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



const getProtocolBadgeStyle = (protocol: string) => {
  switch (protocol) {
    case "can":
      return badgeSuccess;
    case "canfd":
      return badgeCyan;
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
    case "canfd":
      return "CAN-FD";
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
    className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-[var(--bg-primary)] ${textSecondary}`}
  >
    <span className="opacity-70">{label}:</span>
    <span className={`font-mono ${textPrimary}`}>{value}</span>
  </span>
);

const renderConnectionSummary = (profile: IOProfile, t: TFunction) => {
  const c: any = profile.connection || {};
  const s = (key: string) => t(`dataIO.summary.${key}`);

  if (profile.kind === "mqtt") {
    const host = c.host || "localhost";
    const port = c.port || "1883";
    const formats = c.formats || {};

    const enabledFormats = ["json", "savvycan", "decode"].filter(
      (k) => formats?.[k]?.enabled
    );

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("host")} value={host} />
        <SummaryBadge label={s("port")} value={port} />
        {enabledFormats.length > 0 ? (
          <SummaryBadge label={s("formats")} value={enabledFormats.join(",")} />
        ) : (
          <SummaryBadge label={s("formats")} value={s("formatsNone")} />
        )}
      </div>
    );
  }

  if (profile.kind === "postgres") {
    const host = c.host || "localhost";
    const port = c.port || "5432";
    const db = c.database || "wiretap";
    const sourceType = (c.source_type || "can_frame") as string;
    const sourceTypeLabel = t(`dataIO.sourceTypes.${sourceType}`, sourceType);

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("host")} value={host} />
        <SummaryBadge label={s("port")} value={port} />
        <SummaryBadge label={s("db")} value={db} />
        <SummaryBadge label={s("source")} value={sourceTypeLabel} />
        {sourceType === "serial_raw" && c.framing_mode && (
          <SummaryBadge label={s("framing")} value={c.framing_mode} />
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
        <SummaryBadge label={s("host")} value={host} />
        <SummaryBadge label={s("port")} value={port} />
        <SummaryBadge label={s("timeout")} value={`${timeout}s`} />
      </div>
    );
  }

  if (profile.kind === "serial") {
    const port = c.port || s("notSet");
    const baud = c.baud_rate || "115200";
    const framing = c.framing_mode || "raw";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("port")} value={port} />
        <SummaryBadge label={s("baud")} value={baud} />
        <SummaryBadge label={s("framing")} value={framing} />
      </div>
    );
  }

  if (profile.kind === "slcan") {
    const port = c.port || s("notSet");
    const baudRate = c.baud_rate || 115200;
    const bitrate = c.bitrate || 500000;
    const bitrateLabel = bitrate >= 1000000 ? `${bitrate / 1000000}M` : `${bitrate / 1000}k`;
    const silent = c.silent_mode ?? true;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("port")} value={port} />
        {baudRate !== 115200 && <SummaryBadge label={s("baud")} value={baudRate} />}
        <SummaryBadge label={s("bitrate")} value={bitrateLabel} />
        <SummaryBadge label={s("mode")} value={silent ? s("modeSilent") : s("modeActive")} />
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
        <SummaryBadge label={s("interface")} value={iface} />
        {bitrateLabel ? (
          <SummaryBadge label={s("bitrate")} value={bitrateLabel} />
        ) : (
          <SummaryBadge label={s("config")} value={s("configSystem")} />
        )}
      </div>
    );
  }

  if (profile.kind === "gs_usb") {
    const deviceId = c.device_id || s("notSet");
    const bitrate = c.bitrate || 500000;
    const bitrateLabel = bitrate >= 1000000 ? `${bitrate / 1000000}M` : `${bitrate / 1000}k`;
    const listenOnly = c.listen_only ?? true;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("device")} value={deviceId} />
        <SummaryBadge label={s("bitrate")} value={bitrateLabel} />
        <SummaryBadge label={s("mode")} value={listenOnly ? s("modeListen") : s("modeActive")} />
      </div>
    );
  }

  if (profile.kind === "gvret_usb") {
    const port = c.port || s("notSet");
    const baudRate = c.baud_rate || "115200";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("port")} value={port} />
        <SummaryBadge label={s("baud")} value={baudRate} />
      </div>
    );
  }

  if (profile.kind === "modbus_tcp") {
    const host = c.host || "localhost";
    const port = c.port || "502";
    const unitId = c.unit_id || "1";

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("host")} value={host} />
        <SummaryBadge label={s("port")} value={port} />
        <SummaryBadge label={s("unit")} value={unitId} />
      </div>
    );
  }

  if (profile.kind === "framelink") {
    const host = c.host || "";
    const port = c.port || "120";
    const deviceId = c.device_id || "";
    const interfaces = c.interfaces as Array<{ name: string; iface_type: number }> | undefined;
    return (
      <div className="flex flex-wrap gap-2">
        {deviceId && <SummaryBadge label={s("device")} value={deviceId} />}
        {host && <SummaryBadge label={s("host")} value={host} />}
        <SummaryBadge label={s("port")} value={port} />
        {interfaces && <SummaryBadge label={s("interfaces")} value={interfaces.length} />}
      </div>
    );
  }

  if (profile.kind === "virtual") {
    const interfaces: { bus: number; signal_generator: boolean; frame_rate_hz: number | string }[] =
      c.interfaces || [{ bus: 0, signal_generator: true, frame_rate_hz: c.frame_rate_hz || 10 }];
    const busCount = interfaces.length;
    const sigGenCount = interfaces.filter((i) => i.signal_generator !== false).length;
    const loopback = c.loopback !== false;

    return (
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={s("buses")} value={busCount} />
        <SummaryBadge label={s("loopback")} value={loopback ? s("loopbackOn") : s("loopbackOff")} />
        <SummaryBadge
          label={s("signalGen")}
          value={sigGenCount === busCount ? s("signalGenAll") : sigGenCount === 0 ? s("signalGenOff") : `${sigGenCount}/${busCount}`}
        />
        {sigGenCount > 0 && (
          <SummaryBadge
            label={s("rate")}
            value={
              new Set(interfaces.filter((i) => i.signal_generator !== false).map((i) => String(i.frame_rate_hz || 10))).size === 1
                ? `${interfaces.find((i) => i.signal_generator !== false)?.frame_rate_hz || 10} Hz`
                : s("rateMixed")
            }
          />
        )}
      </div>
    );
  }

  // Fallback (should be rare — all known kinds handled above)
  const _exhaustive: never = profile;
  const raw = JSON.stringify((_exhaustive as IOProfile).connection ?? {}, null, 0);
  return (
    <div className={`text-xs font-mono break-all ${textSecondary}`}>
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
  const { t } = useTranslation("settings");

  return (
    <div className={spaceYLarge}>
      <div className="flex items-center justify-between">
        <h2 className={h2}>{t("dataIO.title")}</h2>
        <PrimaryButton onClick={onAddProfile} className="flex items-center gap-1">
          <Plus className={iconMd} />
          {t("dataIO.addProfile")}
        </PrimaryButton>
      </div>

      {ioProfiles.length === 0 ? (
        <div className={`text-center py-12 ${textTertiary}`}>
          <Cable className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>{t("dataIO.empty.heading")}</p>
          <p className="text-sm mt-2">{t("dataIO.empty.description")}</p>
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
                    <span className={badgeDanger}>
                      {t("dataIO.badges.recorded")}
                    </span>
                  )}
                </div>

                {/* Connection summary */}
                <div className="mt-2">
                  {renderConnectionSummary(profile, t)}
                </div>
              </div>

              <div className={`flex items-center ${gapSmall}`}>
                <button
                  onClick={() => onToggleDefaultRead(profile.id)}
                  className={`p-2 ${hoverSubtle} ${roundedDefault} transition-colors`}
                  title={
                    defaultReadProfile === profile.id
                      ? t("dataIO.actions.unsetDefault")
                      : t("dataIO.actions.setDefault")
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
                <button
                  onClick={() => onDuplicateProfile(profile)}
                  className={`p-2 ${hoverSubtle} ${roundedDefault} transition-colors`}
                  title={t("dataIO.actions.duplicate")}
                >
                  <Copy className={`${iconMd} ${textSecondary}`} />
                </button>
                <button
                  onClick={() => onEditProfile(profile)}
                  className={`p-2 ${hoverSubtle} ${roundedDefault} transition-colors`}
                  title={t("dataIO.actions.edit")}
                >
                  <Edit2 className={`${iconMd} ${textSecondary}`} />
                </button>
                <button
                  onClick={() => onDeleteProfile(profile.id)}
                  className={iconButtonHoverDanger}
                  title={t("dataIO.actions.delete")}
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
