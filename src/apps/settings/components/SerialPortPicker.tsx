// ui/src/apps/settings/components/SerialPortPicker.tsx
//
// Component for selecting a serial port from available system ports

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { iconLg } from "../../../styles/spacing";
import { listSerialPorts, SerialPortInfo } from "../../../api/serial";
import { Input, Select } from "../../../components/forms";
import { iconButtonBase } from "../../../styles/buttonStyles";
import { helpText, textDanger, spaceYSmall } from "../../../styles";

interface Props {
  value: string;
  onChange: (port: string) => void;
}

export default function SerialPortPicker({ value, onChange }: Props) {
  const { t } = useTranslation("settings");
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPorts = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const available = await listSerialPorts();
      setPorts(available);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    refreshPorts();
  }, []);

  // Format port display text
  const formatPortOption = (port: SerialPortInfo): string => {
    const parts = [port.port_name];
    if (port.manufacturer) {
      parts.push(`- ${port.manufacturer}`);
    }
    if (port.product) {
      parts.push(port.product);
    }
    return parts.join(" ");
  };

  return (
    <div className={spaceYSmall}>
      <div className="flex gap-2">
        <Select
          variant="default"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        >
          <option value="">{t("serialPortPicker.selectPort")}</option>
          {ports.map((port) => (
            <option key={port.port_name} value={port.port_name}>
              {formatPortOption(port)}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={refreshPorts}
          disabled={isRefreshing}
          className={`${iconButtonBase} disabled:opacity-50`}
          title={t("serialPortPicker.refreshPortList")}
        >
          <RefreshCw
            className={`${iconLg} ${isRefreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {error && <p className={`text-sm ${textDanger}`}>{error}</p>}

      {/* Manual entry fallback */}
      <div>
        <Input
          variant="default"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("serialPortPicker.manualEntryPlaceholder")}
          className="text-sm"
        />
      </div>

      {/* Port details when a USB port is selected */}
      {value && ports.find((p) => p.port_name === value)?.port_type === "USB" && (
        <div className={helpText}>
          {(() => {
            const port = ports.find((p) => p.port_name === value);
            if (!port) return null;
            const details = [];
            if (port.vid && port.pid) {
              details.push(`${t("serialPortPicker.vidPidLabel")} ${port.vid.toString(16).padStart(4, "0")}:${port.pid.toString(16).padStart(4, "0")}`);
            }
            if (port.serial_number) {
              details.push(`${t("serialPortPicker.serialNumberLabel")} ${port.serial_number}`);
            }
            return details.join(" | ");
          })()}
        </div>
      )}
    </div>
  );
}
