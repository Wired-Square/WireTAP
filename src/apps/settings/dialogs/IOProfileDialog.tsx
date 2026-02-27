// ui/src/apps/settings/dialogs/IOProfileDialog.tsx
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { iconMd, iconXs, iconLg, flexRowGap2 } from "../../../styles/spacing";
import { iconButtonHover } from "../../../styles/buttonStyles";
import Dialog from "../../../components/Dialog";
import type { IOProfile } from "../stores/settingsStore";
import { useSettingsStore } from "../stores/settingsStore";
import SerialPortPicker from "../components/SerialPortPicker";
import GsUsbDevicePicker from "../components/GsUsbDevicePicker";
import LinuxCanSetupHelper from "../components/LinuxCanSetupHelper";
import SecurePasswordField from "../components/SecurePasswordField";
import IODeviceStatus, { type DeviceProbeState, type DeviceProbeResult } from "../components/IODeviceStatus";
import { GvretBusConfig, type BusMappingWithProtocol } from "../../../dialogs/io-reader-picker";
import { Input, Select, FormField, PrimaryButton, SecondaryButton } from "../../../components/forms";
import {
  h2,
  h3,
  borderDefault,
  spaceYDefault,
  alertInfo,
  alertWarning,
  caption,
  textMedium,
} from "../../../styles";
import { probeSlcanDevice } from "../../../api/serial";
import { probeGsUsbDevice } from "../../../api/gs_usb";
import { probeDevice, type GvretDeviceInfo } from "../../../api/io";
import { getPlatform, isWindows, isLinux, isMacOS } from "../../../utils/platform";
import { getAvailableProfileKinds, type Platform, type ProfileKind } from "../../../utils/profileTraits";
import type { GvretInterfaceConfig } from "../../../hooks/useSettings";

export type MqttFormatKind = "json" | "savvycan" | "decode";
export type MqttFormatField = "topic" | "enabled";

type Props = {
  isOpen: boolean;
  editingProfileId: string | null;
  profileForm: IOProfile;
  /** Original profile from settings (before edits) - used to detect legacy passwords */
  originalProfile?: IOProfile | null;

  onCancel: () => void;
  onSave: () => void;
  /** Called when user wants to migrate a legacy password to secure storage */
  onMigratePassword?: () => void;

  onUpdateProfileField: (field: keyof IOProfile, value: any) => void;
  onUpdateConnectionField: (key: string, value: string | boolean) => void;
  onUpdateMqttFormat: (
    format: MqttFormatKind,
    field: MqttFormatField,
    value: string | boolean
  ) => void;
};

export default function IOProfileDialog({
  isOpen,
  editingProfileId,
  profileForm,
  originalProfile,
  onCancel,
  onSave,
  onMigratePassword,
  onUpdateProfileField,
  onUpdateConnectionField,
  onUpdateMqttFormat,
}: Props) {
  // Catalog list for preferred decoder picker
  const catalogs = useSettingsStore((s) => s.catalogs.list);

  // Check password storage status
  const isPasswordSecurelyStored = !!profileForm.connection._password_stored;
  // Legacy password exists if there's a password in the original profile that isn't marked as securely stored
  const hasLegacyPassword = !!(
    originalProfile?.connection?.password &&
    !originalProfile?.connection?._password_stored
  );

  // slcan device probe state
  const [slcanProbeState, setSlcanProbeState] = useState<DeviceProbeState>("idle");
  const [slcanProbeResult, setSlcanProbeResult] = useState<DeviceProbeResult | null>(null);

  // slcan advanced options collapsed state
  const [slcanAdvancedOpen, setSlcanAdvancedOpen] = useState(false);

  // GVRET device probe state
  const [gvretProbeState, setGvretProbeState] = useState<DeviceProbeState>("idle");
  const [gvretDeviceInfo, setGvretDeviceInfo] = useState<GvretDeviceInfo | null>(null);
  const [gvretProbeError, setGvretProbeError] = useState<string | null>(null);

  // Reset GVRET probe state when dialog closes or profile type changes
  useEffect(() => {
    if (!isOpen || (profileForm.kind !== "gvret_tcp" && profileForm.kind !== "gvret_usb")) {
      setGvretProbeState("idle");
      setGvretDeviceInfo(null);
      setGvretProbeError(null);
    }
  }, [isOpen, profileForm.kind]);

  // Initialize GVRET device info from profile connection if available
  useEffect(() => {
    if (isOpen && (profileForm.kind === "gvret_tcp" || profileForm.kind === "gvret_usb")) {
      const busCount = profileForm.connection._probed_bus_count;
      if (typeof busCount === "number" && busCount > 0) {
        setGvretDeviceInfo({ bus_count: busCount });
        setGvretProbeState("success");
      }
    }
  }, [isOpen, profileForm.kind, profileForm.connection._probed_bus_count]);

  // Probe GVRET device
  const probeGvret = useCallback(async () => {
    if (!editingProfileId) {
      setGvretProbeError("Save profile first to probe device");
      setGvretProbeState("error");
      return;
    }

    setGvretProbeState("probing");
    setGvretProbeError(null);

    try {
      const result = await probeDevice(editingProfileId);
      if (result.success) {
        setGvretDeviceInfo({ bus_count: result.busCount });
        setGvretProbeState("success");

        const existingInterfaces = profileForm.connection.interfaces as GvretInterfaceConfig[] | undefined;
        const configuredCount = existingInterfaces?.length || 0;

        if (configuredCount === 0) {
          // No interfaces configured yet - create defaults from probe
          const defaultInterfaces: GvretInterfaceConfig[] = Array.from(
            { length: result.busCount },
            (_, i) => ({
              device_bus: i,
              enabled: true,
              protocol: "can" as const,
            })
          );
          onUpdateConnectionField("interfaces", defaultInterfaces as any);
        } else if (configuredCount !== result.busCount) {
          // Interface count mismatch - warn user but keep their config
          setGvretProbeError(
            `Device reports ${result.busCount} interface(s), but ${configuredCount} configured. ` +
            `Delete interfaces field in settings to re-probe.`
          );
        }
        // Store probed bus count (always update to track device state)
        onUpdateConnectionField("_probed_bus_count", result.busCount as any);
      } else {
        setGvretProbeError(result.error || "Probe failed");
        setGvretProbeState("error");
      }
    } catch (e) {
      setGvretProbeError(e instanceof Error ? e.message : String(e));
      setGvretProbeState("error");
    }
  }, [editingProfileId, profileForm.connection.interfaces, onUpdateConnectionField]);

  // Convert GvretInterfaceConfig[] to BusMappingWithProtocol[] for the component
  const getGvretBusConfig = useCallback((): BusMappingWithProtocol[] => {
    const interfaces = profileForm.connection.interfaces as GvretInterfaceConfig[] | undefined;
    if (!interfaces || interfaces.length === 0) {
      // No interfaces configured - show empty state
      return [];
    }
    return interfaces.map((iface) => ({
      deviceBus: iface.device_bus,
      enabled: iface.enabled,
      outputBus: iface.device_bus, // Not used in settings mode
      protocol: iface.protocol,
    }));
  }, [profileForm.connection.interfaces]);

  // Handle bus config changes from GvretBusConfig component
  const handleGvretBusConfigChange = useCallback(
    (config: BusMappingWithProtocol[]) => {
      const interfaces: GvretInterfaceConfig[] = config.map((mapping) => ({
        device_bus: mapping.deviceBus,
        enabled: mapping.enabled,
        protocol: mapping.protocol || "can",
      }));
      onUpdateConnectionField("interfaces", interfaces as any);
    },
    [onUpdateConnectionField]
  );

  // Probe slcan device
  const probeSlcan = useCallback(async () => {
    const port = profileForm.connection.port;
    const baudRate = parseInt(profileForm.connection.baud_rate || "115200", 10);

    if (!port) {
      setSlcanProbeState("idle");
      setSlcanProbeResult(null);
      return;
    }

    // Get serial framing parameters (advanced options)
    const dataBits = parseInt(profileForm.connection.data_bits || "8", 10);
    const stopBits = parseInt(profileForm.connection.stop_bits || "1", 10);
    const parity = profileForm.connection.parity || "none";

    setSlcanProbeState("probing");
    try {
      const result = await probeSlcanDevice(port, baudRate, { dataBits, stopBits, parity });
      setSlcanProbeResult({
        success: result.success,
        primaryInfo: result.version,
        secondaryInfo: result.hardware_version,
        error: result.error,
      });
      setSlcanProbeState(result.success ? "success" : "error");
    } catch (e) {
      setSlcanProbeResult({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      setSlcanProbeState("error");
    }
  }, [
    profileForm.connection.port,
    profileForm.connection.baud_rate,
    profileForm.connection.data_bits,
    profileForm.connection.stop_bits,
    profileForm.connection.parity,
  ]);

  // Auto-probe when slcan port, baud rate, or framing options change
  useEffect(() => {
    if (profileForm.kind === "slcan" && profileForm.connection.port) {
      // Debounce to avoid probing while user is still changing settings
      const timer = setTimeout(() => {
        probeSlcan();
      }, 500);
      return () => clearTimeout(timer);
    } else if (profileForm.kind === "slcan") {
      setSlcanProbeState("idle");
      setSlcanProbeResult(null);
    }
  }, [
    profileForm.kind,
    profileForm.connection.port,
    profileForm.connection.baud_rate,
    profileForm.connection.data_bits,
    profileForm.connection.stop_bits,
    profileForm.connection.parity,
    probeSlcan,
  ]);

  // Reset probe state when dialog closes or profile type changes
  useEffect(() => {
    if (!isOpen || profileForm.kind !== "slcan") {
      setSlcanProbeState("idle");
      setSlcanProbeResult(null);
    }
  }, [isOpen, profileForm.kind]);

  // Platform detection state
  const [platformIsWindows, setPlatformIsWindows] = useState(false);
  const [platformIsLinux, setPlatformIsLinux] = useState(false);
  const [platformIsMacos, setPlatformIsMacos] = useState(false);
  const [availableKinds, setAvailableKinds] = useState<ProfileKind[]>([]);

  useEffect(() => {
    // Individual platform flags for device probing
    isWindows().then(setPlatformIsWindows);
    isLinux().then(setPlatformIsLinux);
    isMacOS().then(setPlatformIsMacos);
    // Available profile kinds based on platform traits
    getPlatform().then((platform) => {
      setAvailableKinds(getAvailableProfileKinds(platform as Platform));
    });
  }, []);

  // gs_usb device probe state (Windows/macOS)
  const [gsUsbProbeState, setGsUsbProbeState] = useState<DeviceProbeState>("idle");
  const [gsUsbProbeResult, setGsUsbProbeResult] = useState<DeviceProbeResult | null>(null);

  // Probe gs_usb device (Windows/macOS - uses nusb userspace driver)
  const probeGsUsb = useCallback(async () => {
    if (!platformIsWindows && !platformIsMacos) return;

    const bus = parseInt(profileForm.connection.bus || "0", 10);
    const address = parseInt(profileForm.connection.address || "0", 10);
    const serial = profileForm.connection.serial || null;

    if (!bus && !address) {
      setGsUsbProbeState("idle");
      setGsUsbProbeResult(null);
      return;
    }

    setGsUsbProbeState("probing");
    try {
      // Pass serial for stable device matching across USB re-enumeration
      const result = await probeGsUsbDevice(bus, address, serial);
      setGsUsbProbeResult({
        success: result.success,
        primaryInfo: result.channel_count ? `${result.channel_count} channel(s)` : undefined,
        secondaryInfo: result.supports_fd ? "CAN FD supported" : undefined,
        error: result.error || undefined,
      });
      setGsUsbProbeState(result.success ? "success" : "error");
    } catch (e) {
      setGsUsbProbeResult({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      setGsUsbProbeState("error");
    }
  }, [platformIsWindows, platformIsMacos, profileForm.connection.bus, profileForm.connection.address, profileForm.connection.serial]);

  // Auto-probe gs_usb device when bus/address changes (Windows/macOS)
  useEffect(() => {
    if (profileForm.kind === "gs_usb" && (platformIsWindows || platformIsMacos) && (profileForm.connection.bus || profileForm.connection.address)) {
      const timer = setTimeout(() => {
        probeGsUsb();
      }, 500);
      return () => clearTimeout(timer);
    } else if (profileForm.kind === "gs_usb") {
      setGsUsbProbeState("idle");
      setGsUsbProbeResult(null);
    }
  }, [profileForm.kind, platformIsWindows, platformIsMacos, profileForm.connection.bus, profileForm.connection.address, probeGsUsb]);

  // Reset gs_usb probe state when dialog closes or profile type changes
  useEffect(() => {
    if (!isOpen || profileForm.kind !== "gs_usb") {
      setGsUsbProbeState("idle");
      setGsUsbProbeResult(null);
    }
  }, [isOpen, profileForm.kind]);

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="max-h-[90vh] overflow-y-auto">
        <div className={`p-6 border-b ${borderDefault} flex items-center justify-between`}>
          <h2 className={h2}>
            {editingProfileId ? "Edit IO Profile" : "Add IO Profile"}
          </h2>
          <button
            onClick={onCancel}
            className={iconButtonHover}
            title="Go back without saving"
          >
            <ArrowLeft className={`${iconLg} text-[color:var(--text-muted)]`} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Profile Name */}
          <FormField label="Profile Name" required variant="default">
            <Input
              variant="default"
              value={profileForm.name}
              onChange={(e) => onUpdateProfileField("name", e.target.value)}
              placeholder="My IO Profile"
            />
          </FormField>

          {/* Profile Type - filtered based on platform availability */}
          <FormField label="Type" variant="default">
            <Select
              variant="default"
              value={profileForm.kind}
              onChange={(e) =>
                onUpdateProfileField("kind", e.target.value as IOProfile["kind"])
              }
            >
              {availableKinds.includes("csv_file") && <option value="csv_file">CSV File</option>}
              {availableKinds.includes("gs_usb") && <option value="gs_usb">gs_usb (candleLight)</option>}
              {availableKinds.includes("gvret_tcp") && <option value="gvret_tcp">GVRET TCP</option>}
              {availableKinds.includes("gvret_usb") && <option value="gvret_usb">GVRET USB (Serial)</option>}
              {availableKinds.includes("mqtt") && <option value="mqtt">MQTT</option>}
              {availableKinds.includes("postgres") && <option value="postgres">PostgreSQL</option>}
              {availableKinds.includes("serial") && <option value="serial">Serial Port</option>}
              {availableKinds.includes("slcan") && <option value="slcan">slcan (CANable, USB-CAN)</option>}
              {availableKinds.includes("socketcan") && <option value="socketcan">SocketCAN (Linux)</option>}
            </Select>
          </FormField>

          {/* Preferred Decoder */}
          <FormField label="Preferred Decoder" variant="default">
            <Select
              variant="default"
              value={profileForm.preferred_catalog || ""}
              onChange={(e) => onUpdateProfileField("preferred_catalog", e.target.value || undefined)}
            >
              <option value="">None</option>
              {catalogs.map((c) => (
                <option key={c.filename} value={c.filename}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>

          {/* MQTT */}
          {profileForm.kind === "mqtt" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>MQTT Connection</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Host" variant="default">
                  <Input
                    variant="default"
                    value={profileForm.connection.host || ""}
                    onChange={(e) => onUpdateConnectionField("host", e.target.value)}
                    placeholder="localhost"
                  />
                </FormField>
                <FormField label="Port" variant="default">
                  <Input
                    variant="default"
                    type="number"
                    value={profileForm.connection.port || ""}
                    onChange={(e) => onUpdateConnectionField("port", e.target.value)}
                    placeholder="1883"
                  />
                </FormField>
              </div>

              <FormField label="Username (optional)" variant="default">
                <Input
                  variant="default"
                  value={profileForm.connection.username || ""}
                  onChange={(e) => onUpdateConnectionField("username", e.target.value)}
                />
              </FormField>

              <SecurePasswordField
                value={profileForm.connection.password || ""}
                onChange={(value) => onUpdateConnectionField("password", value)}
                isSecurelyStored={isPasswordSecurelyStored}
                hasLegacyPassword={hasLegacyPassword}
                onMigrate={onMigratePassword}
                optional
              />

              {/* MQTT Formats */}
              <div className={`border-t ${borderDefault} pt-4 mt-6`}>
                <h4 className="text-md font-semibold text-[color:var(--text-primary)] mb-4">
                  Message Formats
                </h4>

                {/* JSON */}
                <div className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="checkbox"
                      id="format-json"
                      checked={profileForm.connection.formats?.json?.enabled || false}
                      onChange={(e) =>
                        onUpdateMqttFormat("json", "enabled", e.target.checked)
                      }
                      className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                    />
                    <label
                      htmlFor="format-json"
                      className={textMedium}
                    >
                      JSON Format
                    </label>
                  </div>
                  <FormField label="Base Topic" variant="default">
                    <Input
                      variant="default"
                      value={profileForm.connection.formats?.json?.topic || ""}
                      onChange={(e) => onUpdateMqttFormat("json", "topic", e.target.value)}
                      placeholder="candor/json/{bus}/{id_hex}/{signal}"
                    />
                  </FormField>
                </div>

                {/* SavvyCAN */}
                <div className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="checkbox"
                      id="format-savvycan"
                      checked={profileForm.connection.formats?.savvycan?.enabled || false}
                      onChange={(e) =>
                        onUpdateMqttFormat("savvycan", "enabled", e.target.checked)
                      }
                      className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                    />
                    <label
                      htmlFor="format-savvycan"
                      className={textMedium}
                    >
                      SavvyCAN Format
                    </label>
                  </div>
                  <FormField label="Base Topic" variant="default">
                    <Input
                      variant="default"
                      value={profileForm.connection.formats?.savvycan?.topic || ""}
                      onChange={(e) =>
                        onUpdateMqttFormat("savvycan", "topic", e.target.value)
                      }
                      placeholder="candor-savvycan/{id_dec}"
                    />
                  </FormField>
                </div>

                {/* Decode */}
                <div className="mb-4 p-4 bg-[var(--bg-surface)] rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="checkbox"
                      id="format-decode"
                      checked={profileForm.connection.formats?.decode?.enabled || false}
                      onChange={(e) =>
                        onUpdateMqttFormat("decode", "enabled", e.target.checked)
                      }
                      className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                    />
                    <label
                      htmlFor="format-decode"
                      className={textMedium}
                    >
                      Decode Format
                    </label>
                  </div>
                  <FormField label="Base Topic" variant="default">
                    <Input
                      variant="default"
                      value={profileForm.connection.formats?.decode?.topic || ""}
                      onChange={(e) => onUpdateMqttFormat("decode", "topic", e.target.value)}
                      placeholder="candor/decode/{signal_name}/{id_hex}/{signal}"
                    />
                  </FormField>
                </div>
              </div>
            </div>
          )}

          {/* PostgreSQL */}
          {profileForm.kind === "postgres" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>PostgreSQL Connection</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Host" variant="default">
                  <Input
                    variant="default"
                    value={profileForm.connection.host || ""}
                    onChange={(e) => onUpdateConnectionField("host", e.target.value)}
                    placeholder="localhost"
                  />
                </FormField>
                <FormField label="Port" variant="default">
                  <Input
                    variant="default"
                    type="number"
                    value={profileForm.connection.port || ""}
                    onChange={(e) => onUpdateConnectionField("port", e.target.value)}
                    placeholder="5432"
                  />
                </FormField>
              </div>

              <FormField label="Database" variant="default">
                <Input
                  variant="default"
                  value={profileForm.connection.database || ""}
                  onChange={(e) => onUpdateConnectionField("database", e.target.value)}
                  placeholder="candor"
                />
              </FormField>

              <FormField label="Username" variant="default">
                <Input
                  variant="default"
                  value={profileForm.connection.username || ""}
                  onChange={(e) => onUpdateConnectionField("username", e.target.value)}
                />
              </FormField>

              <SecurePasswordField
                value={profileForm.connection.password || ""}
                onChange={(value) => onUpdateConnectionField("password", value)}
                isSecurelyStored={isPasswordSecurelyStored}
                hasLegacyPassword={hasLegacyPassword}
                onMigrate={onMigratePassword}
              />

              <FormField label="SSL Mode" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.sslmode || "prefer"}
                  onChange={(e) => onUpdateConnectionField("sslmode", e.target.value)}
                >
                  <option value="disable">Disable</option>
                  <option value="allow">Allow</option>
                  <option value="prefer">Prefer</option>
                  <option value="require">Require</option>
                  <option value="verify-ca">Verify CA</option>
                  <option value="verify-full">Verify Full</option>
                </Select>
              </FormField>

              <FormField label="Source Type" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.source_type || "can_frame"}
                  onChange={(e) => onUpdateConnectionField("source_type", e.target.value)}
                >
                  <option value="can_frame">CAN Frames (public.can_frame)</option>
                  <option value="modbus_frame">Modbus Frames (public.modbus_frame)</option>
                  <option value="serial_frame">Serial Frames (public.serial_frame)</option>
                  <option value="serial_raw">Serial Raw (public.serial_raw)</option>
                </Select>
              </FormField>

              {/* Note: Framing for serial_raw is handled client-side in Discovery mode */}

              <FormField label="Default Playback Speed" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.default_speed || "1"}
                  onChange={(e) => onUpdateConnectionField("default_speed", e.target.value)}
                >
                  <option value="0.25">0.25x</option>
                  <option value="0.5">0.5x</option>
                  <option value="1">1x (realtime)</option>
                  <option value="2">2x</option>
                  <option value="10">10x</option>
                  <option value="30">30x</option>
                  <option value="60">60x</option>
                  <option value="0">No Limit</option>
                </Select>
              </FormField>
            </div>
          )}

          {/* GVRET */}
          {profileForm.kind === "gvret_tcp" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>GVRET TCP Connection</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Host" variant="default">
                  <Input
                    variant="default"
                    value={profileForm.connection.host || ""}
                    onChange={(e) => onUpdateConnectionField("host", e.target.value)}
                    placeholder="192.168.1.100"
                  />
                </FormField>
                <FormField label="Port" variant="default">
                  <Input
                    variant="default"
                    type="number"
                    value={profileForm.connection.port || ""}
                    onChange={(e) => onUpdateConnectionField("port", e.target.value)}
                    placeholder="23"
                  />
                </FormField>
              </div>

              <FormField label="Connection Timeout (seconds)" variant="default">
                <Input
                  variant="default"
                  type="number"
                  value={profileForm.connection.timeout || "5"}
                  onChange={(e) => onUpdateConnectionField("timeout", e.target.value)}
                  placeholder="5"
                />
              </FormField>

              <div className={flexRowGap2}>
                <input
                  type="checkbox"
                  id="tcp-keepalive"
                  checked={profileForm.connection.tcp_keepalive !== false}
                  onChange={(e) =>
                    onUpdateConnectionField("tcp_keepalive", e.target.checked)
                  }
                  className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                />
                <label
                  htmlFor="tcp-keepalive"
                  className={textMedium}
                >
                  TCP Keepalive
                </label>
              </div>

              {/* Interface Configuration */}
              <div className={`border-t ${borderDefault} pt-4 mt-4`}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className={textMedium}>
                    CAN Interfaces
                    {gvretProbeState === "success" && (
                      <span className="ml-2 text-xs text-[color:var(--text-green)]">
                        (device online)
                      </span>
                    )}
                  </h4>
                  <SecondaryButton
                    onClick={probeGvret}
                    disabled={gvretProbeState === "probing"}
                    className="text-xs py-1 px-2"
                  >
                    <RefreshCw className={`${iconXs} mr-1 ${gvretProbeState === "probing" ? "animate-spin" : ""}`} />
                    {gvretProbeState === "probing" ? "Probing..." : "Probe Device"}
                  </SecondaryButton>
                </div>

                {!editingProfileId && (
                  <div className={alertInfo}>
                    <p className="text-sm text-[color:var(--text-info)]">
                      Save the profile first to probe the device and configure interfaces.
                    </p>
                  </div>
                )}

                {gvretProbeError && (
                  <div className={alertWarning}>
                    <p className="text-sm text-[color:var(--text-amber)]">
                      {gvretProbeError}
                    </p>
                  </div>
                )}

                {getGvretBusConfig().length > 0 && (
                  <GvretBusConfig
                    deviceInfo={gvretDeviceInfo}
                    isLoading={gvretProbeState === "probing"}
                    error={gvretProbeState === "error" ? gvretProbeError : null}
                    busConfig={getGvretBusConfig()}
                    onBusConfigChange={handleGvretBusConfigChange}
                    showOutputBus={false}
                    showProtocol={true}
                  />
                )}

                {editingProfileId && getGvretBusConfig().length === 0 && gvretProbeState !== "probing" && gvretProbeState !== "error" && (
                  <p className="text-sm text-[color:var(--text-muted)]">
                    Click "Probe Device" to detect available interfaces.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* GVRET USB */}
          {profileForm.kind === "gvret_usb" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>GVRET USB Connection</h3>

              {/* Port Selection */}
              <FormField label="Serial Port" variant="default">
                <SerialPortPicker
                  value={profileForm.connection.port || ""}
                  onChange={(port) => onUpdateConnectionField("port", port)}
                />
              </FormField>

              {/* Serial Baud Rate */}
              <FormField label="Serial Baud Rate" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.baud_rate || "115200"}
                  onChange={(e) => onUpdateConnectionField("baud_rate", e.target.value)}
                >
                  <option value="115200">115200 (default)</option>
                  <option value="460800">460800</option>
                  <option value="921600">921600</option>
                  <option value="1000000">1000000</option>
                  <option value="2000000">2000000</option>
                </Select>
              </FormField>

              <div className={alertInfo}>
                <p className="text-sm text-[color:var(--text-info)]">
                  Works with ESP32-RET, M2RET, CANDue, and other GVRET-compatible hardware over USB serial.
                  Supports multi-bus devices and frame transmission.
                </p>
              </div>

              {/* Interface Configuration */}
              <div className={`border-t ${borderDefault} pt-4 mt-4`}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className={textMedium}>
                    CAN Interfaces
                    {gvretProbeState === "success" && (
                      <span className="ml-2 text-xs text-[color:var(--text-green)]">
                        (device online)
                      </span>
                    )}
                  </h4>
                  <SecondaryButton
                    onClick={probeGvret}
                    disabled={gvretProbeState === "probing"}
                    className="text-xs py-1 px-2"
                  >
                    <RefreshCw className={`${iconXs} mr-1 ${gvretProbeState === "probing" ? "animate-spin" : ""}`} />
                    {gvretProbeState === "probing" ? "Probing..." : "Probe Device"}
                  </SecondaryButton>
                </div>

                {!editingProfileId && (
                  <div className={alertInfo}>
                    <p className="text-sm text-[color:var(--text-info)]">
                      Save the profile first to probe the device and configure interfaces.
                    </p>
                  </div>
                )}

                {gvretProbeError && (
                  <div className={alertWarning}>
                    <p className="text-sm text-[color:var(--text-amber)]">
                      {gvretProbeError}
                    </p>
                  </div>
                )}

                {getGvretBusConfig().length > 0 && (
                  <GvretBusConfig
                    deviceInfo={gvretDeviceInfo}
                    isLoading={gvretProbeState === "probing"}
                    error={gvretProbeState === "error" ? gvretProbeError : null}
                    busConfig={getGvretBusConfig()}
                    onBusConfigChange={handleGvretBusConfigChange}
                    showOutputBus={false}
                    showProtocol={true}
                  />
                )}

                {editingProfileId && getGvretBusConfig().length === 0 && gvretProbeState !== "probing" && gvretProbeState !== "error" && (
                  <p className="text-sm text-[color:var(--text-muted)]">
                    Click "Probe Device" to detect available interfaces.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* CSV File */}
          {profileForm.kind === "csv_file" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>CSV File Reader</h3>

              <FormField label="File Path (optional)" variant="default">
                <Input
                  variant="default"
                  value={profileForm.connection.file_path || ""}
                  onChange={(e) => onUpdateConnectionField("file_path", e.target.value)}
                  placeholder="/path/to/file.csv"
                />
              </FormField>

              <div className={alertInfo}>
                <p className="text-sm text-[color:var(--text-info)]">
                  {profileForm.connection.file_path
                    ? "This profile will always use the specified file."
                    : "Leave empty to select a file when starting the stream."}
                  {" "}Supports GVRET/SavvyCAN CSV format.
                </p>
              </div>

              <FormField label="Default Playback Speed" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.default_speed || "0"}
                  onChange={(e) => onUpdateConnectionField("default_speed", e.target.value)}
                >
                  <option value="0.25">0.25x</option>
                  <option value="0.5">0.5x</option>
                  <option value="1">1x (realtime)</option>
                  <option value="2">2x</option>
                  <option value="10">10x</option>
                  <option value="30">30x</option>
                  <option value="60">60x</option>
                  <option value="0">No Limit (Recommended)</option>
                </Select>
              </FormField>
            </div>
          )}

          {/* Serial Port */}
          {profileForm.kind === "serial" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>Serial Port Connection</h3>

              {/* Port Selection */}
              <FormField label="Port" variant="default">
                <SerialPortPicker
                  value={profileForm.connection.port || ""}
                  onChange={(port) => onUpdateConnectionField("port", port)}
                />
              </FormField>

              {/* Baud Rate */}
              <FormField label="Baud Rate" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.baud_rate || "115200"}
                  onChange={(e) => onUpdateConnectionField("baud_rate", e.target.value)}
                >
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                  <option value="230400">230400</option>
                  <option value="460800">460800</option>
                  <option value="921600">921600</option>
                </Select>
              </FormField>

              {/* Data Bits, Stop Bits, Parity */}
              <div className="grid grid-cols-3 gap-4">
                <FormField label="Data Bits" variant="default">
                  <Select
                    variant="default"
                    value={profileForm.connection.data_bits || "8"}
                    onChange={(e) => onUpdateConnectionField("data_bits", e.target.value)}
                  >
                    <option value="8">8</option>
                    <option value="7">7</option>
                    <option value="6">6</option>
                    <option value="5">5</option>
                  </Select>
                </FormField>
                <FormField label="Stop Bits" variant="default">
                  <Select
                    variant="default"
                    value={profileForm.connection.stop_bits || "1"}
                    onChange={(e) => onUpdateConnectionField("stop_bits", e.target.value)}
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                  </Select>
                </FormField>
                <FormField label="Parity" variant="default">
                  <Select
                    variant="default"
                    value={profileForm.connection.parity || "none"}
                    onChange={(e) => onUpdateConnectionField("parity", e.target.value)}
                  >
                    <option value="none">None</option>
                    <option value="odd">Odd</option>
                    <option value="even">Even</option>
                  </Select>
                </FormField>
              </div>

              {/* Note: Framing is now handled client-side in Discovery mode */}
            </div>
          )}

          {/* slcan (CANable) */}
          {profileForm.kind === "slcan" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>slcan Connection (CANable)</h3>

              {/* Port Selection */}
              <FormField label="Serial Port" variant="default">
                <SerialPortPicker
                  value={profileForm.connection.port || ""}
                  onChange={(port) => onUpdateConnectionField("port", port)}
                />
              </FormField>

              {/* Serial Baud Rate */}
              <FormField label="Serial Baud Rate" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.baud_rate || "115200"}
                  onChange={(e) => onUpdateConnectionField("baud_rate", e.target.value)}
                >
                  <option value="115200">115200 (default for CANable)</option>
                  <option value="460800">460800</option>
                  <option value="921600">921600</option>
                  <option value="1000000">1000000</option>
                  <option value="2000000">2000000</option>
                  <option value="3000000">3000000</option>
                </Select>
              </FormField>

              {/* Device Status */}
              {profileForm.connection.port && (
                <IODeviceStatus
                  state={slcanProbeState}
                  result={slcanProbeResult}
                  primaryLabel="Firmware"
                  secondaryLabel="HW"
                  onRefresh={probeSlcan}
                  probingText="Checking CANable..."
                  successText="CANable connected"
                  errorText="CANable not responding"
                  idleText="Select a port to check device"
                />
              )}

              {/* CAN Bus Bitrate */}
              <FormField label="CAN Bitrate" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.bitrate || "500000"}
                  onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
                >
                  <option value="10000">10 Kbit/s (S0)</option>
                  <option value="20000">20 Kbit/s (S1)</option>
                  <option value="50000">50 Kbit/s (S2)</option>
                  <option value="100000">100 Kbit/s (S3)</option>
                  <option value="125000">125 Kbit/s (S4)</option>
                  <option value="250000">250 Kbit/s (S5)</option>
                  <option value="500000">500 Kbit/s (S6)</option>
                  <option value="750000">750 Kbit/s (S7)</option>
                  <option value="1000000">1 Mbit/s (S8)</option>
                </Select>
              </FormField>

              {/* Silent mode */}
              <div className={flexRowGap2}>
                <input
                  type="checkbox"
                  id="silent-mode"
                  checked={profileForm.connection.silent_mode !== false}
                  onChange={(e) => onUpdateConnectionField("silent_mode", e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                />
                <label
                  htmlFor="silent-mode"
                  className={textMedium}
                >
                  Silent mode (no ACK, no transmit)
                </label>
              </div>
              <p className={`${caption} -mt-2`}>
                Does not participate in bus arbitration. Ideal for passive monitoring.
              </p>

              {/* Advanced Serial Options */}
              <div className="border-t border-[color:var(--border-default)] pt-4 mt-4">
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
                  Advanced Serial Options
                </button>

                {slcanAdvancedOpen && (
                  <div className="mt-3 space-y-3 pl-6">
                    <p className={caption}>
                      Most slcan devices use 8N1 (8 data bits, no parity, 1 stop bit). Only change these if your device requires different settings.
                    </p>
                    <div className="grid grid-cols-3 gap-4">
                      <FormField label="Data Bits" variant="default">
                        <Select
                          variant="default"
                          value={profileForm.connection.data_bits || "8"}
                          onChange={(e) => onUpdateConnectionField("data_bits", e.target.value)}
                        >
                          <option value="8">8</option>
                          <option value="7">7</option>
                          <option value="6">6</option>
                          <option value="5">5</option>
                        </Select>
                      </FormField>
                      <FormField label="Stop Bits" variant="default">
                        <Select
                          variant="default"
                          value={profileForm.connection.stop_bits || "1"}
                          onChange={(e) => onUpdateConnectionField("stop_bits", e.target.value)}
                        >
                          <option value="1">1</option>
                          <option value="2">2</option>
                        </Select>
                      </FormField>
                      <FormField label="Parity" variant="default">
                        <Select
                          variant="default"
                          value={profileForm.connection.parity || "none"}
                          onChange={(e) => onUpdateConnectionField("parity", e.target.value)}
                        >
                          <option value="none">None</option>
                          <option value="odd">Odd</option>
                          <option value="even">Even</option>
                        </Select>
                      </FormField>
                    </div>
                  </div>
                )}
              </div>

              <div className={alertInfo}>
                <p className="text-sm text-[color:var(--text-info)]">
                  Works with CANable, CANable Pro (slcan firmware), and other USB-CAN adapters
                  using the Lawicel/slcan ASCII protocol.
                </p>
              </div>
            </div>
          )}

          {/* SocketCAN (Linux) */}
          {profileForm.kind === "socketcan" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>SocketCAN (Linux)</h3>

              <FormField label="Interface Name" variant="default">
                <Input
                  variant="default"
                  value={profileForm.connection.interface || "can0"}
                  onChange={(e) => onUpdateConnectionField("interface", e.target.value)}
                  placeholder="can0"
                />
              </FormField>

              {/* CAN Bitrate - optional */}
              <FormField label="CAN Bitrate (optional)" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.bitrate || ""}
                  onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
                >
                  <option value="">Use system configuration</option>
                  <option value="10000">10 Kbit/s</option>
                  <option value="20000">20 Kbit/s</option>
                  <option value="50000">50 Kbit/s</option>
                  <option value="100000">100 Kbit/s</option>
                  <option value="125000">125 Kbit/s</option>
                  <option value="250000">250 Kbit/s</option>
                  <option value="500000">500 Kbit/s</option>
                  <option value="750000">750 Kbit/s</option>
                  <option value="1000000">1 Mbit/s</option>
                </Select>
              </FormField>

              {/* CAN FD Options - only show if bitrate is set (interface will be configured) */}
              {profileForm.connection.bitrate && (
                <div className={`border-t ${borderDefault} pt-4 mt-2`}>
                  <div className={flexRowGap2}>
                    <input
                      type="checkbox"
                      id="socketcan_enable_fd"
                      checked={profileForm.connection.enable_fd === true}
                      onChange={(e) => onUpdateConnectionField("enable_fd", e.target.checked)}
                      className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                    />
                    <label htmlFor="socketcan_enable_fd" className="text-sm text-[color:var(--text-secondary)]">
                      Enable CAN FD
                    </label>
                  </div>
                  <p className="text-xs text-[color:var(--text-muted)] mt-1 ml-6">
                    Enables CAN Flexible Data-rate. Requires FD-capable hardware.
                  </p>

                  {profileForm.connection.enable_fd && (
                    <div className="mt-3 pl-6">
                      <FormField label="Data Phase Bitrate" variant="default">
                        <Select
                          variant="default"
                          value={profileForm.connection.data_bitrate || "2000000"}
                          onChange={(e) => onUpdateConnectionField("data_bitrate", e.target.value)}
                        >
                          <option value="1000000">1 Mbit/s</option>
                          <option value="2000000">2 Mbit/s</option>
                          <option value="4000000">4 Mbit/s</option>
                          <option value="5000000">5 Mbit/s</option>
                          <option value="8000000">8 Mbit/s</option>
                        </Select>
                      </FormField>
                    </div>
                  )}
                </div>
              )}

              <div className={alertInfo}>
                <p className="text-sm text-[color:var(--text-info)]">
                  <strong>Linux only.</strong> Works with CANable Pro (Candlelight firmware),
                  native CAN hardware, or virtual CAN (vcan).
                </p>
                <p className="text-sm text-[color:var(--text-info)] mt-2">
                  {profileForm.connection.bitrate
                    ? "CANdor will configure the interface automatically (requires authentication)."
                    : "Leave bitrate empty to use the interface as already configured by the system."}
                </p>
              </div>
            </div>
          )}

          {/* gs_usb (candleLight) */}
          {profileForm.kind === "gs_usb" && (
            <div className={`${spaceYDefault} border-t ${borderDefault} pt-6`}>
              <h3 className={h3}>gs_usb (candleLight)</h3>

              {/* Device Selection */}
              <FormField label="Device" variant="default">
                <GsUsbDevicePicker
                  value={profileForm.connection.device_id || ""}
                  onChange={(deviceId, device) => {
                    onUpdateConnectionField("device_id", deviceId);
                    if (device) {
                      onUpdateConnectionField("bus", String(device.bus));
                      onUpdateConnectionField("address", String(device.address));
                      // Store serial number for stable device identification across reconnects
                      if (device.serial) {
                        onUpdateConnectionField("serial", device.serial);
                      }
                      if (device.interface_name) {
                        onUpdateConnectionField("interface", device.interface_name);
                      }
                    }
                  }}
                />
              </FormField>

              {/* CAN Bitrate */}
              <FormField label="CAN Bitrate" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.bitrate || "500000"}
                  onChange={(e) => onUpdateConnectionField("bitrate", e.target.value)}
                >
                  <option value="10000">10 Kbit/s</option>
                  <option value="20000">20 Kbit/s</option>
                  <option value="50000">50 Kbit/s</option>
                  <option value="100000">100 Kbit/s</option>
                  <option value="125000">125 Kbit/s</option>
                  <option value="250000">250 Kbit/s</option>
                  <option value="500000">500 Kbit/s</option>
                  <option value="750000">750 Kbit/s</option>
                  <option value="1000000">1 Mbit/s</option>
                </Select>
              </FormField>

              {/* Sample Point */}
              <FormField label="Sample Point" variant="default">
                <Select
                  variant="default"
                  value={profileForm.connection.sample_point || "87.5"}
                  onChange={(e) => onUpdateConnectionField("sample_point", e.target.value)}
                >
                  <option value="75.0">75.0%</option>
                  <option value="80.0">80.0%</option>
                  <option value="87.5">87.5% (recommended)</option>
                </Select>
              </FormField>

              {/* Listen-only mode */}
              <div className={flexRowGap2}>
                <input
                  type="checkbox"
                  id="gs_usb_listen_only"
                  checked={profileForm.connection.listen_only !== false}
                  onChange={(e) => onUpdateConnectionField("listen_only", e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                />
                <label htmlFor="gs_usb_listen_only" className="text-sm text-[color:var(--text-secondary)]">
                  Listen-only mode (no ACK, no transmit)
                </label>
              </div>

              {/* CAN FD Options */}
              <div className={`border-t ${borderDefault} pt-4 mt-2`}>
                <div className={flexRowGap2}>
                  <input
                    type="checkbox"
                    id="gs_usb_enable_fd"
                    checked={profileForm.connection.enable_fd === true}
                    onChange={(e) => onUpdateConnectionField("enable_fd", e.target.checked)}
                    className="w-4 h-4 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
                  />
                  <label htmlFor="gs_usb_enable_fd" className="text-sm text-[color:var(--text-secondary)]">
                    Enable CAN FD
                  </label>
                  {gsUsbProbeResult?.supports_fd === false && (
                    <span className="text-xs text-[color:var(--text-warning)]">(device does not support FD)</span>
                  )}
                  {gsUsbProbeResult?.supports_fd === true && (
                    <span className="text-xs text-[color:var(--text-success)]">(FD capable)</span>
                  )}
                </div>
                <p className="text-xs text-[color:var(--text-muted)] mt-1 ml-6">
                  Enables CAN Flexible Data-rate for higher throughput and larger payloads (up to 64 bytes).
                </p>

                {profileForm.connection.enable_fd && (
                  <div className="mt-3 space-y-3 pl-6">
                    <FormField label="Data Phase Bitrate" variant="default">
                      <Select
                        variant="default"
                        value={profileForm.connection.data_bitrate || "2000000"}
                        onChange={(e) => onUpdateConnectionField("data_bitrate", e.target.value)}
                      >
                        <option value="1000000">1 Mbit/s</option>
                        <option value="2000000">2 Mbit/s</option>
                        <option value="4000000">4 Mbit/s</option>
                        <option value="5000000">5 Mbit/s</option>
                        <option value="8000000">8 Mbit/s</option>
                      </Select>
                    </FormField>

                    <FormField label="Data Phase Sample Point" variant="default">
                      <Select
                        variant="default"
                        value={profileForm.connection.data_sample_point || "75.0"}
                        onChange={(e) => onUpdateConnectionField("data_sample_point", e.target.value)}
                      >
                        <option value="60.0">60.0%</option>
                        <option value="70.0">70.0%</option>
                        <option value="75.0">75.0% (recommended)</option>
                        <option value="80.0">80.0%</option>
                      </Select>
                    </FormField>
                  </div>
                )}
              </div>

              {/* Linux: Setup command helper */}
              {platformIsLinux && profileForm.connection.interface && (
                <LinuxCanSetupHelper
                  interfaceName={profileForm.connection.interface}
                  bitrate={parseInt(profileForm.connection.bitrate || "500000", 10)}
                />
              )}

              {/* Windows/macOS: Device status indicator */}
              {(platformIsWindows || platformIsMacos) && profileForm.connection.device_id && (
                <IODeviceStatus
                  state={gsUsbProbeState}
                  result={gsUsbProbeResult}
                  primaryLabel="Channels"
                  secondaryLabel="Features"
                  onRefresh={probeGsUsb}
                  probingText="Checking device..."
                  successText="Device connected"
                  errorText="Device not responding"
                />
              )}

              <div className={alertInfo}>
                <p className="text-sm text-[color:var(--text-info)]">
                  Works with CANable, CANable Pro (candleLight firmware), and other gs_usb-compatible devices.
                  {platformIsWindows && " WinUSB driver should install automatically."}
                  {platformIsMacos && " macOS allows direct USB access - no driver needed."}
                  {platformIsLinux && " On Linux, the kernel gs_usb driver exposes devices as SocketCAN interfaces."}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={`p-6 border-t ${borderDefault} flex justify-end gap-3`}>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={onSave}>
            {editingProfileId ? "Update Profile" : "Add Profile"}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
