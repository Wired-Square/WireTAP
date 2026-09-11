// src/components/io/IOConnectionFields.tsx
//
// The per-kind connection parameters of an IO profile — host/port, serial port
// and 8N1, CAN bitrate, MQTT topics, and so on. Extracted from the Settings
// profile dialog so the source picker's device editor offers the same fields
// for an ad-hoc device without restating them.
//
// Everything writes through one untyped `onUpdateConnectionField(key, value)`
// setter, so a host only needs to own the draft profile.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../styles/spacing";
import {
  h3,
  borderDefault,
  spaceYDefault,
  alertInfo,
  alertWarning,
  caption,
  textMedium,
  textMuted,
  textSuccess,
  textWarning,
} from "../../styles";
import { Input, Select, FormField, CheckboxField, SecondaryButton } from "../forms";
import BaudRateSelect from "../forms/BaudRateSelect";
import SerialPortPicker from "./SerialPortPicker";
import GsUsbDevicePicker from "./GsUsbDevicePicker";
import LinuxCanSetupHelper from "./LinuxCanSetupHelper";
import SecurePasswordField from "./SecurePasswordField";
import IODeviceStatus from "./IODeviceStatus";
import DeviceBusConfig from "../../dialogs/io-source-picker/DeviceBusConfig";
import type { BusMapping } from "../../api/io";
import { useKindSupportedProtocols } from "../../stores/profileBusStore";
import {
  SLCAN_BITRATES,
  SLCAN_DATA_BITRATES,
  CAN_BITRATES,
  CAN_FD_DATA_BITRATES,
  bitrateOptions,
} from "./canBitrates";
import type { ConnectionProbe, PlatformInfo } from "./useConnectionProbe";
import type {
  IOProfile,
  ConnectionFieldValue,
  GvretInterfaceConfig,
  VirtualInterfaceConfig,
} from "../../settings/appSettings";
import { isProfileKind } from "../../settings/appSettings";

export type MqttFormatKind = "json" | "savvycan" | "decode";
export type MqttFormatField = "topic" | "enabled";

export interface IOConnectionFieldsProps {
  /** The profile form being edited — only `kind` and `connection` are read. */
  profile: IOProfile;
  onUpdateConnectionField: (key: string, value: ConnectionFieldValue) => void;
  /** Probe state, from `useConnectionProbe`. */
  probe: ConnectionProbe;
  platform: PlatformInfo;
  /**
   * Whether GVRET's probe can resolve this device. False shows the "save first"
   * hint instead of a bus list, since `probe_device` needs a registered profile.
   */
  canProbeByProfileId: boolean;

  /** Secure-field state. Omit where secrets are kept inline (ad-hoc devices). */
  isPasswordSecurelyStored?: boolean;
  isApiKeySecurelyStored?: boolean;
  hasLegacyPassword?: boolean;
  onMigratePassword?: () => void;

  /**
   * Slot for the FrameLink per-interface signal panel — reading and writing a
   * connected device's settings. Settings fills it; the picker leaves it out,
   * since operating a device is not the same as connecting to one.
   */
  frameLinkSignalPanel?: React.ReactNode;
}

/** A database size the way the gateway's admin UI shows it. */
function formatGigabytes(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 10 ? `${gb.toFixed(0)} GB` : gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

/** The 8N1 trio, identical for serial and for slcan's advanced options. */
function SerialLineFields({
  connection,
  onUpdateConnectionField,
}: {
  connection: { data_bits?: string; stop_bits?: string; parity?: string };
  onUpdateConnectionField: (key: string, value: ConnectionFieldValue) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="grid grid-cols-3 gap-4">
      <FormField label={t("ioProfileDialog.serial.dataBits")} variant="default">
        <Select
          variant="default"
          value={connection.data_bits || "8"}
          onChange={(e) => onUpdateConnectionField("data_bits", e.target.value)}
        >
          <option value="8">8</option>
          <option value="7">7</option>
          <option value="6">6</option>
          <option value="5">5</option>
        </Select>
      </FormField>
      <FormField label={t("ioProfileDialog.serial.stopBits")} variant="default">
        <Select
          variant="default"
          value={connection.stop_bits || "1"}
          onChange={(e) => onUpdateConnectionField("stop_bits", e.target.value)}
        >
          <option value="1">1</option>
          <option value="2">2</option>
        </Select>
      </FormField>
      <FormField label={t("ioProfileDialog.serial.parity")} variant="default">
        <Select
          variant="default"
          value={connection.parity || "none"}
          onChange={(e) => onUpdateConnectionField("parity", e.target.value)}
        >
          <option value="none">{t("ioProfileDialog.serial.parityOptions.none")}</option>
          <option value="odd">{t("ioProfileDialog.serial.parityOptions.odd")}</option>
          <option value="even">{t("ioProfileDialog.serial.parityOptions.even")}</option>
        </Select>
      </FormField>
    </div>
  );
}

/** Host + port side by side, the shape every TCP kind uses. */
function HostPortFields({
  host,
  port,
  hostPlaceholder,
  portPlaceholder,
  hostRequired,
  onUpdateConnectionField,
}: {
  host?: string;
  port?: string;
  hostPlaceholder: string;
  portPlaceholder: string;
  hostRequired?: boolean;
  onUpdateConnectionField: (key: string, value: ConnectionFieldValue) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="grid grid-cols-2 gap-4">
      <FormField label={t("ioProfileDialog.common.host")} required={hostRequired} variant="default">
        <Input
          variant="default"
          value={host || ""}
          onChange={(e) => onUpdateConnectionField("host", e.target.value)}
          placeholder={hostPlaceholder}
        />
      </FormField>
      <FormField label={t("ioProfileDialog.common.port")} variant="default">
        <Input
          variant="default"
          type="number"
          value={port || ""}
          onChange={(e) => onUpdateConnectionField("port", e.target.value)}
          placeholder={portPlaceholder}
        />
      </FormField>
    </div>
  );
}

/** A labelled checkbox with an optional hint below it, and room for a badge. */
function ToggleField({
  checked,
  onChange,
  label,
  hint,
  trailing,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div>
      <div className={flexRowGap2}>
        <CheckboxField
          checked={checked}
          onChange={onChange}
          label={label}
          labelClass={textMedium}
        />
        {trailing}
      </div>
      {hint && <p className="text-xs text-[color:var(--text-muted)] mt-1 ml-6">{hint}</p>}
    </div>
  );
}

export default function IOConnectionFields({
  profile,
  onUpdateConnectionField,
  probe,
  platform,
  canProbeByProfileId,
  isPasswordSecurelyStored = false,
  isApiKeySecurelyStored = false,
  hasLegacyPassword = false,
  onMigratePassword,
  frameLinkSignalPanel,
}: IOConnectionFieldsProps) {
  const { t } = useTranslation("settings");
  const [slcanAdvancedOpen, setSlcanAdvancedOpen] = useState(false);

  // MQTT format edits are just a nested write into `formats`, so they derive
  // from the one connection setter rather than needing their own prop.
  const updateMqttFormat = useCallback(
    (format: MqttFormatKind, field: MqttFormatField, value: string | boolean) => {
      if (!isProfileKind(profile, "mqtt")) return;
      const formats = profile.connection.formats || {
        json: { topic: "", enabled: false },
        savvycan: { topic: "", enabled: false },
        decode: { topic: "", enabled: false },
      };
      onUpdateConnectionField("formats", {
        ...formats,
        [format]: { ...formats[format], [field]: value },
      });
    },
    [profile, onUpdateConnectionField],
  );

  // GVRET's bus list, in the shape DeviceBusConfig wants. A memo, not a
  // callback: it is read three times per render and never used as an identity.
  const supportedProtocols = useKindSupportedProtocols(profile.kind);

  const deviceBusConfig = useMemo((): BusMapping[] => {
    if (!isProfileKind(profile, "gvret_tcp") && !isProfileKind(profile, "gvret_usb")) return [];
    return (profile.connection.interfaces ?? []).map((iface) => ({
      deviceBus: iface.device_bus,
      enabled: iface.enabled,
      outputBus: iface.device_bus, // unused when showOutputBus is false
      protocol: iface.protocol,
      supportedProtocols,
    }));
  }, [profile, supportedProtocols]);

  const handleDeviceBusConfigChange = useCallback(
    (config: BusMapping[]) => {
      const interfaces: GvretInterfaceConfig[] = config.map((m) => ({
        device_bus: m.deviceBus,
        enabled: m.enabled,
        // Settings is the only place a protocol is persisted; the source
        // picker's copy of this dropdown is a session-only override.
        protocol: (m.protocol === "canfd" ? "canfd" : "can"),
      }));
      onUpdateConnectionField("interfaces", interfaces);
    },
    [onUpdateConnectionField],
  );

  const section = `${spaceYDefault} border-t ${borderDefault} pt-6`;

  /** GVRET's probe row + bus list, shared by the TCP and USB blocks. A
   *  function so the markup is not built for every other device kind. */
  const renderGvretInterfaces = () => (
    <div className={`border-t ${borderDefault} pt-4 mt-4`}>
      <div className="flex items-center justify-between mb-3">
        <h4 className={textMedium}>
          {t("ioProfileDialog.common.canInterfaces")}
          {probe.gvretState === "success" && (
            <span className="ml-2 text-xs text-[color:var(--text-green)]">
              {t("ioProfileDialog.common.deviceOnline")}
            </span>
          )}
        </h4>
        <SecondaryButton
          onClick={probe.probeGvret}
          disabled={probe.gvretState === "probing"}
          className="text-xs py-1 px-2"
        >
          <RefreshCw
            className={`${iconXs} mr-1 ${probe.gvretState === "probing" ? "animate-spin" : ""}`}
          />
          {probe.gvretState === "probing"
            ? t("ioProfileDialog.common.probing")
            : t("ioProfileDialog.common.probeDevice")}
        </SecondaryButton>
      </div>

      {!canProbeByProfileId && (
        <div className={alertInfo}>
          <p className="text-sm text-[color:var(--text-info)]">
            {t("ioProfileDialog.common.saveFirstHint")}
          </p>
        </div>
      )}

      {probe.gvretError && (
        <div className={alertWarning}>
          <p className="text-sm text-[color:var(--text-amber)]">{probe.gvretError}</p>
        </div>
      )}

      {deviceBusConfig.length > 0 && (
        <DeviceBusConfig
          deviceInfo={probe.gvretDeviceInfo}
          isLoading={probe.gvretState === "probing"}
          error={probe.gvretState === "error" ? probe.gvretError : null}
          busConfig={deviceBusConfig}
          onBusConfigChange={handleDeviceBusConfigChange}
          showOutputBus={false}
          showProtocol={true}
        />
      )}

      {canProbeByProfileId &&
        deviceBusConfig.length === 0 &&
        probe.gvretState !== "probing" &&
        probe.gvretState !== "error" && (
          <p className="text-sm text-[color:var(--text-muted)]">
            {t("ioProfileDialog.common.clickProbeHint")}
          </p>
        )}
    </div>
  );

  // ── MQTT ───────────────────────────────────────────────────────────────────
  if (isProfileKind(profile, "mqtt")) {
    const formats: { kind: MqttFormatKind; label: string; placeholder: string }[] = [
      {
        kind: "json",
        label: t("ioProfileDialog.mqtt.jsonFormat"),
        placeholder: t("ioProfileDialog.mqtt.jsonTopicPlaceholder"),
      },
      {
        kind: "savvycan",
        label: t("ioProfileDialog.mqtt.savvycanFormat"),
        placeholder: t("ioProfileDialog.mqtt.savvycanTopicPlaceholder"),
      },
      {
        kind: "decode",
        label: t("ioProfileDialog.mqtt.decodeFormat"),
        placeholder: t("ioProfileDialog.mqtt.decodeTopicPlaceholder"),
      },
    ];

    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.mqtt.title")}</h3>

        <HostPortFields
          host={profile.connection.host}
          port={profile.connection.port}
          hostPlaceholder={t("ioProfileDialog.mqtt.hostPlaceholder")}
          portPlaceholder={t("ioProfileDialog.mqtt.portPlaceholder")}
          onUpdateConnectionField={onUpdateConnectionField}
        />

        <FormField label={t("ioProfileDialog.common.usernameOptional")} variant="default">
          <Input
            variant="default"
            value={profile.connection.username || ""}
            onChange={(e) => onUpdateConnectionField("username", e.target.value)}
          />
        </FormField>

        <SecurePasswordField
          value={profile.connection.password || ""}
          onChange={(value) => onUpdateConnectionField("password", value)}
          isSecurelyStored={isPasswordSecurelyStored}
          hasLegacyPassword={hasLegacyPassword}
          onMigrate={onMigratePassword}
          optional
        />

        <div className={`border-t ${borderDefault} pt-4 mt-6`}>
          <h4 className="text-md font-semibold text-[color:var(--text-primary)] mb-4">
            {t("ioProfileDialog.mqtt.messageFormats")}
          </h4>

          {formats.map(({ kind, label, placeholder }) => (
            <div key={kind} className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
              <div className="mb-3">
                <CheckboxField
                  checked={profile.connection.formats?.[kind]?.enabled || false}
                  onChange={(v) => updateMqttFormat(kind, "enabled", v)}
                  label={label}
                  labelClass={textMedium}
                />
              </div>
              <FormField label={t("ioProfileDialog.mqtt.baseTopic")} variant="default">
                <Input
                  variant="default"
                  value={profile.connection.formats?.[kind]?.topic || ""}
                  onChange={(e) => updateMqttFormat(kind, "topic", e.target.value)}
                  placeholder={placeholder}
                />
              </FormField>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Modbus TCP ─────────────────────────────────────────────────────────────
  if (isProfileKind(profile, "modbus_tcp")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.modbus.title")}</h3>

        <HostPortFields
          host={profile.connection.host}
          port={profile.connection.port}
          hostPlaceholder={t("ioProfileDialog.modbus.hostPlaceholder")}
          portPlaceholder={t("ioProfileDialog.modbus.portPlaceholder")}
          onUpdateConnectionField={onUpdateConnectionField}
        />

        <FormField label={t("ioProfileDialog.modbus.unitId")} variant="default">
          <Input
            variant="default"
            type="number"
            value={profile.connection.unit_id || ""}
            onChange={(e) => onUpdateConnectionField("unit_id", e.target.value)}
            placeholder={t("ioProfileDialog.modbus.unitIdPlaceholder")}
          />
        </FormField>
      </div>
    );
  }

  // ── WireTAP backend ────────────────────────────────────────────────────────
  if (isProfileKind(profile, "wiretap")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.wiretap.title")}</h3>
        <p className={caption}>{t("ioProfileDialog.wiretap.description")}</p>

        <FormField label={t("ioProfileDialog.wiretap.url")} variant="default">
          <Input
            variant="default"
            value={profile.connection.url || ""}
            onChange={(e) => onUpdateConnectionField("url", e.target.value)}
            placeholder={t("ioProfileDialog.wiretap.urlPlaceholder")}
          />
        </FormField>

        <SecurePasswordField
          label={t("ioProfileDialog.wiretap.apiKey")}
          value={profile.connection.api_key || ""}
          onChange={(value) => onUpdateConnectionField("api_key", value)}
          isSecurelyStored={isApiKeySecurelyStored}
          hasLegacyPassword={false}
        />

        {profile.connection.url && (
          <IODeviceStatus
            state={probe.wiretapState}
            result={probe.wiretapResult}
            primaryLabel={t("ioProfileDialog.wiretap.versionLabel")}
            secondaryLabel={t("ioProfileDialog.wiretap.databasesLabel")}
            onRefresh={probe.probeWiretap}
            probingText={t("ioProfileDialog.wiretap.probingText")}
            successText={t("ioProfileDialog.wiretap.successText")}
            errorText={
              probe.wiretapResult?.primaryInfo
                ? t("ioProfileDialog.wiretap.keyRefused", { version: probe.wiretapResult.primaryInfo })
                : t("ioProfileDialog.wiretap.errorText")
            }
            idleText={t("ioProfileDialog.wiretap.idleText")}
          />
        )}

        <FormField label={t("ioProfileDialog.wiretap.database")} variant="default">
          {/* A datalist rather than a select: the gateway's list is a suggestion,
              and a name it did not list still has to be typeable. */}
          <Input
            variant="default"
            list="wiretap-databases"
            value={profile.connection.database || ""}
            onChange={(e) => onUpdateConnectionField("database", e.target.value)}
            placeholder={t("ioProfileDialog.wiretap.databasePlaceholder")}
          />
          <datalist id="wiretap-databases">
            {probe.wiretapDatabases.map((db) => (
              <option key={db.name} value={db.name}>
                {formatGigabytes(db.size_bytes)}
              </option>
            ))}
          </datalist>
        </FormField>

        <FormField label={t("ioProfileDialog.wiretap.protocol")} variant="default">
          <Select
            variant="default"
            value={profile.connection.protocol || "can"}
            onChange={(e) => onUpdateConnectionField("protocol", e.target.value)}
          >
            <option value="can">{t("ioProfileDialog.wiretap.protocols.can")}</option>
            <option value="modbus">{t("ioProfileDialog.wiretap.protocols.modbus")}</option>
          </Select>
          <p className={`${caption} mt-1`}>
            {probe.wiretapProtocols === null
              ? t("ioProfileDialog.wiretap.protocolHint")
              : probe.wiretapProtocols.length === 0
                ? t("ioProfileDialog.wiretap.databaseEmpty")
                : t("ioProfileDialog.wiretap.databaseHolds", {
                    protocols: probe.wiretapProtocols
                      .map((p) => t(`ioProfileDialog.wiretap.protocols.${p}`))
                      .join(", "),
                  })}
          </p>
        </FormField>

        <FormField label={t("ioProfileDialog.wiretap.defaultSpeed")} variant="default">
          <Select
            variant="default"
            value={profile.connection.default_speed || "1"}
            onChange={(e) => onUpdateConnectionField("default_speed", e.target.value)}
          >
            <option value="0.25">{t("ioProfileDialog.wiretap.speeds.025")}</option>
            <option value="0.5">{t("ioProfileDialog.wiretap.speeds.05")}</option>
            <option value="1">{t("ioProfileDialog.wiretap.speeds.1")}</option>
            <option value="2">{t("ioProfileDialog.wiretap.speeds.2")}</option>
            <option value="10">{t("ioProfileDialog.wiretap.speeds.10")}</option>
            <option value="30">{t("ioProfileDialog.wiretap.speeds.30")}</option>
            <option value="60">{t("ioProfileDialog.wiretap.speeds.60")}</option>
            <option value="0">{t("ioProfileDialog.wiretap.speeds.noLimit")}</option>
          </Select>
        </FormField>
      </div>
    );
  }

  // ── Virtual adapter ────────────────────────────────────────────────────────
  if (isProfileKind(profile, "virtual")) {
    const defaultIface: VirtualInterfaceConfig = {
      bus: 0,
      signal_generator: true,
      frame_rate_hz: 10,
    };
    const interfaces = profile.connection.interfaces || [defaultIface];
    const updateIface = (idx: number, patch: Partial<VirtualInterfaceConfig>) => {
      const next = [...interfaces];
      next[idx] = { ...next[idx], ...patch };
      onUpdateConnectionField("interfaces", next);
    };

    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.virtual.title")}</h3>
        <p className={caption}>{t("ioProfileDialog.virtual.description")}</p>

        <div className="grid grid-cols-2 gap-4">
          <FormField label={t("ioProfileDialog.virtual.trafficType")} variant="default">
            <Select
              variant="default"
              value={profile.connection.traffic_type || "can"}
              onChange={(e) => onUpdateConnectionField("traffic_type", e.target.value)}
            >
              <option value="can">{t("ioProfileDialog.virtual.trafficTypes.can")}</option>
              <option value="canfd">{t("ioProfileDialog.virtual.trafficTypes.canfd")}</option>
              <option value="modbus">{t("ioProfileDialog.virtual.trafficTypes.modbus")}</option>
              <option value="serial">{t("ioProfileDialog.virtual.trafficTypes.serial")}</option>
            </Select>
          </FormField>
          <FormField label="" variant="default">
            <div className="pt-6">
              <CheckboxField
                checked={profile.connection.loopback !== false}
                onChange={(v) => onUpdateConnectionField("loopback", v)}
                label={t("ioProfileDialog.virtual.loopback")}
                labelClass={textMedium}
              />
            </div>
          </FormField>
        </div>

        <FormField label={t("ioProfileDialog.virtual.interfaces")} variant="default">
          <Select
            variant="default"
            value={String(profile.connection.interfaces?.length || 1)}
            onChange={(e) => {
              const count = parseInt(e.target.value, 10);
              const existing = profile.connection.interfaces || [];
              onUpdateConnectionField(
                "interfaces",
                Array.from({ length: count }, (_, i) => existing[i] || { ...defaultIface, bus: i }),
              );
            }}
          >
            {[1, 2, 3, 4, 8].map((n) => (
              <option key={n} value={String(n)}>
                {t("ioProfileDialog.virtual.interfacesCount", { count: n })}
              </option>
            ))}
          </Select>
        </FormField>

        {interfaces.map((iface, idx) => (
          <div
            key={idx}
            className={`flex items-center gap-3 py-1.5 ${idx > 0 ? `border-t ${borderDefault}` : ""}`}
          >
            <span className={`${textMedium} w-14 shrink-0`}>
              {t("ioProfileDialog.virtual.busLabel", { bus: iface.bus })}
            </span>
            <Input
              variant="default"
              type="number"
              min="1"
              max="1000"
              step="1"
              value={iface.frame_rate_hz || "10"}
              onChange={(e) => updateIface(idx, { frame_rate_hz: parseFloat(e.target.value) || 0 })}
              placeholder="10"
              className="w-20"
            />
            <span className={`${caption} shrink-0`}>{t("ioProfileDialog.virtual.hz")}</span>
            <div className="ml-auto shrink-0">
              <CheckboxField
                checked={iface.signal_generator !== false}
                onChange={(v) => updateIface(idx, { signal_generator: v })}
                label={t("ioProfileDialog.virtual.signalGenerator")}
                labelClass={textMedium}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── GVRET over TCP ─────────────────────────────────────────────────────────
  if (isProfileKind(profile, "gvret_tcp")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.gvret.tcpTitle")}</h3>

        <HostPortFields
          host={profile.connection.host}
          port={profile.connection.port}
          hostPlaceholder={t("ioProfileDialog.gvret.hostPlaceholder")}
          portPlaceholder={t("ioProfileDialog.gvret.portPlaceholder")}
          onUpdateConnectionField={onUpdateConnectionField}
        />

        <FormField label={t("ioProfileDialog.common.connectionTimeout")} variant="default">
          <Input
            variant="default"
            type="number"
            value={profile.connection.timeout || "5"}
            onChange={(e) => onUpdateConnectionField("timeout", e.target.value)}
            placeholder={t("ioProfileDialog.gvret.timeoutPlaceholder")}
          />
        </FormField>

        <ToggleField
          checked={profile.connection.tcp_keepalive !== false}
          onChange={(v) => onUpdateConnectionField("tcp_keepalive", v)}
          label={t("ioProfileDialog.common.tcpKeepalive")}
        />

        {renderGvretInterfaces()}
      </div>
    );
  }

  // ── GVRET over USB ─────────────────────────────────────────────────────────
  if (isProfileKind(profile, "gvret_usb")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.gvret.usbTitle")}</h3>

        <FormField label={t("ioProfileDialog.gvret.serialPort")} variant="default">
          <SerialPortPicker
            value={profile.connection.port || ""}
            onChange={(port) => onUpdateConnectionField("port", port)}
          />
        </FormField>

        <FormField label={t("ioProfileDialog.gvret.serialBaudRate")} variant="default">
          <BaudRateSelect
            value={profile.connection.baud_rate || "115200"}
            onChange={(v) => onUpdateConnectionField("baud_rate", v)}
            defaultLabel={t("ioProfileDialog.gvret.baudDefault")}
          />
        </FormField>

        <div className={alertInfo}>
          <p className="text-sm text-[color:var(--text-info)]">
            {t("ioProfileDialog.gvret.usbHint")}
          </p>
        </div>

        {renderGvretInterfaces()}
      </div>
    );
  }

  // ── FrameLink ──────────────────────────────────────────────────────────────
  if (isProfileKind(profile, "framelink")) {
    const flInterfaceCount = profile.connection.interfaces?.length ?? 0;
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.framelink.title")}</h3>

        <HostPortFields
          host={profile.connection.host}
          port={profile.connection.port}
          hostPlaceholder={t("ioProfileDialog.framelink.hostPlaceholder")}
          portPlaceholder={t("ioProfileDialog.framelink.portPlaceholder")}
          hostRequired
          onUpdateConnectionField={onUpdateConnectionField}
        />

        <FormField label={t("ioProfileDialog.common.connectionTimeout")} variant="default">
          <Input
            variant="default"
            type="number"
            value={profile.connection.timeout || "5"}
            onChange={(e) => onUpdateConnectionField("timeout", e.target.value)}
            placeholder="5"
          />
        </FormField>

        {/* Probing is what populates `interfaces`, so it belongs with the
            connection parameters rather than in the Settings-only slot below —
            without it an ad-hoc FrameLink device could never be configured. */}
        <div className={`border-t ${borderDefault} pt-4 mt-4`}>
          <div className="flex items-center justify-between">
            <p className={`text-sm ${textMuted}`}>
              {flInterfaceCount > 0
                ? t("ioProfileDialog.framelink.interfacesTitle", { count: flInterfaceCount })
                : t("ioProfileDialog.framelink.notProbed")}
            </p>
            <SecondaryButton
              onClick={probe.probeFramelink}
              disabled={probe.framelinkState === "probing"}
            >
              <RefreshCw
                className={`${iconXs} ${probe.framelinkState === "probing" ? "animate-spin" : ""}`}
              />
              {probe.framelinkState === "probing"
                ? t("ioProfileDialog.framelink.reprobing")
                : t("ioProfileDialog.framelink.reprobe")}
            </SecondaryButton>
          </div>
          {probe.framelinkError && (
            <div className={`${alertWarning} mt-3`}>
              <p className={`text-sm ${textWarning}`}>{probe.framelinkError}</p>
            </div>
          )}
        </div>

        {frameLinkSignalPanel}
      </div>
    );
  }

  // ── Serial port ────────────────────────────────────────────────────────────
  if (isProfileKind(profile, "serial")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.serial.title")}</h3>

        <FormField label={t("ioProfileDialog.serial.port")} variant="default">
          <SerialPortPicker
            value={profile.connection.port || ""}
            onChange={(port) => onUpdateConnectionField("port", port)}
          />
        </FormField>

        <FormField label={t("ioProfileDialog.serial.baudRate")} variant="default">
          <BaudRateSelect
            value={profile.connection.baud_rate || "115200"}
            onChange={(v) => onUpdateConnectionField("baud_rate", v)}
          />
        </FormField>

        <SerialLineFields
          connection={profile.connection}
          onUpdateConnectionField={onUpdateConnectionField}
        />

        {/* Framing is configured per session in the picker, not on the profile. */}
      </div>
    );
  }

  // ── slcan (CANable) ────────────────────────────────────────────────────────
  if (isProfileKind(profile, "slcan")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.slcan.title")}</h3>

        <FormField label={t("ioProfileDialog.slcan.serialPort")} variant="default">
          <SerialPortPicker
            value={profile.connection.port || ""}
            onChange={(port) => onUpdateConnectionField("port", port)}
          />
        </FormField>

        <FormField label={t("ioProfileDialog.slcan.serialBaudRate")} variant="default">
          <BaudRateSelect
            value={profile.connection.baud_rate || "115200"}
            onChange={(v) => onUpdateConnectionField("baud_rate", v)}
            defaultLabel={t("ioProfileDialog.slcan.baudDefault")}
          />
        </FormField>

        {profile.connection.port && (
          <IODeviceStatus
            state={probe.slcanState}
            result={probe.slcanResult}
            primaryLabel={t("ioProfileDialog.slcan.firmwareLabel")}
            secondaryLabel={t("ioProfileDialog.slcan.hwLabel")}
            onRefresh={probe.probeSlcan}
            probingText={t("ioProfileDialog.slcan.probingText")}
            successText={t("ioProfileDialog.slcan.successText")}
            errorText={t("ioProfileDialog.slcan.errorText")}
            idleText={t("ioProfileDialog.slcan.idleText")}
          />
        )}

        <FormField label={t("ioProfileDialog.slcan.canBitrate")} variant="default">
          <Select
            variant="default"
            value={profile.connection.bitrate || "500000"}
            onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
          >
            {bitrateOptions(SLCAN_BITRATES)}
          </Select>
        </FormField>

        <ToggleField
          checked={profile.connection.silent_mode !== false}
          onChange={(v) => onUpdateConnectionField("silent_mode", v)}
          label={t("ioProfileDialog.slcan.silentMode")}
          hint={t("ioProfileDialog.slcan.silentModeHint")}
        />

        {/* CAN FD (ELMUE firmware extension) */}
        <div className={`border-t ${borderDefault} pt-4 mt-2`}>
          <ToggleField
            checked={profile.connection.enable_fd === true}
            onChange={(v) => onUpdateConnectionField("enable_fd", v)}
            label={t("ioProfileDialog.slcan.enableFd")}
            hint={t("ioProfileDialog.slcan.fdHint")}
            trailing={
              <>
                {probe.slcanResult?.supports_fd === true && (
                  <span className={`text-xs ${textSuccess}`}>
                    {t("ioProfileDialog.slcan.fdCapable")}
                  </span>
                )}
                {probe.slcanResult?.supports_fd === false && profile.connection.enable_fd && (
                  <span className={`text-xs ${textWarning}`}>
                    {t("ioProfileDialog.slcan.fdNotSupported")}
                  </span>
                )}
              </>
            }
          />

          {profile.connection.enable_fd && (
            <div className="mt-3 space-y-3 pl-6">
              <FormField label={t("ioProfileDialog.slcan.dataPhaseBitrate")} variant="default">
                <Select
                  variant="default"
                  value={profile.connection.data_bitrate || "2000000"}
                  onChange={(e) => onUpdateConnectionField("data_bitrate", e.target.value)}
                >
                  {bitrateOptions(SLCAN_DATA_BITRATES)}
                </Select>
              </FormField>
            </div>
          )}
        </div>

        {/* Advanced serial line settings */}
        <div className={`border-t ${borderDefault} pt-4 mt-4`}>
          <button
            type="button"
            onClick={() => setSlcanAdvancedOpen(!slcanAdvancedOpen)}
            className="flex items-center gap-2 text-sm font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          >
            {slcanAdvancedOpen ? (
              <ChevronDown className={iconMd} />
            ) : (
              <ChevronRight className={iconMd} />
            )}
            {t("ioProfileDialog.slcan.advancedSerial")}
          </button>

          {slcanAdvancedOpen && (
            <div className="mt-3 space-y-3 pl-6">
              <p className={caption}>{t("ioProfileDialog.slcan.advancedHint")}</p>
              <SerialLineFields
                connection={profile.connection}
                onUpdateConnectionField={onUpdateConnectionField}
              />
            </div>
          )}
        </div>

        <div className={alertInfo}>
          <p className="text-sm text-[color:var(--text-info)]">
            {t("ioProfileDialog.slcan.supportHint")}
          </p>
        </div>
      </div>
    );
  }

  // ── SocketCAN (Linux) ──────────────────────────────────────────────────────
  if (isProfileKind(profile, "socketcan")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.socketcan.title")}</h3>

        <FormField label={t("ioProfileDialog.socketcan.interfaceName")} variant="default">
          <Input
            variant="default"
            value={profile.connection.interface || "can0"}
            onChange={(e) => onUpdateConnectionField("interface", e.target.value)}
            placeholder={t("ioProfileDialog.socketcan.interfacePlaceholder")}
          />
        </FormField>

        <FormField label={t("ioProfileDialog.socketcan.canBitrate")} variant="default">
          <Select
            variant="default"
            value={profile.connection.bitrate || ""}
            onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
          >
            <option value="">{t("ioProfileDialog.socketcan.useSystemConfig")}</option>
            {bitrateOptions(CAN_BITRATES)}
          </Select>
        </FormField>

        {/* FD only applies when we configure the interface ourselves. */}
        {profile.connection.bitrate && (
          <div className={`border-t ${borderDefault} pt-4 mt-2`}>
            <ToggleField
              checked={profile.connection.enable_fd === true}
              onChange={(v) => onUpdateConnectionField("enable_fd", v)}
              label={t("ioProfileDialog.socketcan.enableFd")}
              hint={t("ioProfileDialog.socketcan.fdHint")}
            />

            {profile.connection.enable_fd && (
              <div className="mt-3 pl-6">
                <FormField label={t("ioProfileDialog.socketcan.dataPhaseBitrate")} variant="default">
                  <Select
                    variant="default"
                    value={profile.connection.data_bitrate || "2000000"}
                    onChange={(e) => onUpdateConnectionField("data_bitrate", e.target.value)}
                  >
                    {bitrateOptions(CAN_FD_DATA_BITRATES)}
                  </Select>
                </FormField>
              </div>
            )}
          </div>
        )}

        <div className={alertInfo}>
          <p className="text-sm text-[color:var(--text-info)]">
            <strong>{t("ioProfileDialog.socketcan.linuxHintBold")}</strong>
            {t("ioProfileDialog.socketcan.linuxHintRest")}
          </p>
          <p className="text-sm text-[color:var(--text-info)] mt-2">
            {profile.connection.bitrate
              ? t("ioProfileDialog.socketcan.configureAuto")
              : t("ioProfileDialog.socketcan.configureManual")}
          </p>
        </div>
      </div>
    );
  }

  // ── gs_usb (candleLight) ───────────────────────────────────────────────────
  if (isProfileKind(profile, "gs_usb")) {
    return (
      <div className={section}>
        <h3 className={h3}>{t("ioProfileDialog.gsUsb.title")}</h3>

        <FormField label={t("ioProfileDialog.gsUsb.device")} variant="default">
          <GsUsbDevicePicker
            value={profile.connection.device_id || ""}
            onChange={(deviceId, device) => {
              onUpdateConnectionField("device_id", deviceId);
              if (!device) return;
              onUpdateConnectionField("bus", String(device.bus));
              onUpdateConnectionField("address", String(device.address));
              // Serial gives stable identification across USB re-enumeration.
              if (device.serial) onUpdateConnectionField("serial", device.serial);
              if (device.interface_name) {
                onUpdateConnectionField("interface", device.interface_name);
              }
            }}
          />
        </FormField>

        <FormField label={t("ioProfileDialog.gsUsb.canBitrate")} variant="default">
          <Select
            variant="default"
            value={profile.connection.bitrate || "500000"}
            onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
          >
            {bitrateOptions(CAN_BITRATES)}
          </Select>
        </FormField>

        <FormField label={t("ioProfileDialog.gsUsb.samplePoint")} variant="default">
          <Select
            variant="default"
            value={profile.connection.sample_point || "87.5"}
            onChange={(e) => onUpdateConnectionField("sample_point", e.target.value)}
          >
            <option value="75.0">{t("ioProfileDialog.gsUsb.samplePoints.750")}</option>
            <option value="80.0">{t("ioProfileDialog.gsUsb.samplePoints.800")}</option>
            <option value="87.5">{t("ioProfileDialog.gsUsb.samplePoints.875")}</option>
          </Select>
        </FormField>

        <ToggleField
          checked={profile.connection.listen_only !== false}
          onChange={(v) => onUpdateConnectionField("listen_only", v)}
          label={t("ioProfileDialog.gsUsb.listenOnly")}
        />

        <div className={`border-t ${borderDefault} pt-4 mt-2`}>
          <ToggleField
            checked={profile.connection.enable_fd === true}
            onChange={(v) => onUpdateConnectionField("enable_fd", v)}
            label={t("ioProfileDialog.gsUsb.enableFd")}
            hint={t("ioProfileDialog.gsUsb.fdHint")}
            trailing={
              <>
                {probe.gsUsbResult?.supports_fd === false && (
                  <span className={`text-xs ${textWarning}`}>
                    {t("ioProfileDialog.gsUsb.fdNotSupported")}
                  </span>
                )}
                {probe.gsUsbResult?.supports_fd === true && (
                  <span className="text-xs text-[color:var(--text-success)]">
                    {t("ioProfileDialog.gsUsb.fdCapable")}
                  </span>
                )}
              </>
            }
          />

          {profile.connection.enable_fd && (
            <div className="mt-3 space-y-3 pl-6">
              <FormField label={t("ioProfileDialog.gsUsb.dataPhaseBitrate")} variant="default">
                <Select
                  variant="default"
                  value={profile.connection.data_bitrate || "2000000"}
                  onChange={(e) => onUpdateConnectionField("data_bitrate", e.target.value)}
                >
                  {bitrateOptions(CAN_FD_DATA_BITRATES)}
                </Select>
              </FormField>

              <FormField label={t("ioProfileDialog.gsUsb.dataPhaseSamplePoint")} variant="default">
                <Select
                  variant="default"
                  value={profile.connection.data_sample_point || "75.0"}
                  onChange={(e) => onUpdateConnectionField("data_sample_point", e.target.value)}
                >
                  <option value="60.0">{t("ioProfileDialog.gsUsb.dataPhaseSamplePoints.600")}</option>
                  <option value="70.0">{t("ioProfileDialog.gsUsb.dataPhaseSamplePoints.700")}</option>
                  <option value="75.0">{t("ioProfileDialog.gsUsb.dataPhaseSamplePoints.750")}</option>
                  <option value="80.0">{t("ioProfileDialog.gsUsb.dataPhaseSamplePoints.800")}</option>
                </Select>
              </FormField>
            </div>
          )}
        </div>

        {platform.isLinux && profile.connection.interface && (
          <LinuxCanSetupHelper
            interfaceName={profile.connection.interface}
            bitrate={parseInt(profile.connection.bitrate || "500000", 10)}
          />
        )}

        {(platform.isWindows || platform.isMacos) && profile.connection.device_id && (
          <IODeviceStatus
            state={probe.gsUsbState}
            result={probe.gsUsbResult}
            primaryLabel={t("ioProfileDialog.gsUsb.channelsLabel")}
            secondaryLabel={t("ioProfileDialog.gsUsb.featuresLabel")}
            onRefresh={probe.probeGsUsb}
            probingText={t("ioProfileDialog.gsUsb.probingText")}
            successText={t("ioProfileDialog.gsUsb.successText")}
            errorText={t("ioProfileDialog.gsUsb.errorText")}
          />
        )}

        <div className={alertInfo}>
          <p className="text-sm text-[color:var(--text-info)]">
            {t("ioProfileDialog.gsUsb.supportHint")}
            {platform.isWindows && t("ioProfileDialog.gsUsb.winNote")}
            {platform.isMacos && t("ioProfileDialog.gsUsb.macNote")}
            {platform.isLinux && t("ioProfileDialog.gsUsb.linuxNote")}
          </p>
        </div>
      </div>
    );
  }

  return null;
}
