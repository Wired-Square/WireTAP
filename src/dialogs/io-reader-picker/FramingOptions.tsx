// ui/src/dialogs/io-reader-picker/FramingOptions.tsx
//
// Framing configuration options for serial data sources.
// Allows capturing both raw bytes and framed data simultaneously.
// Uses the shared FramingOptionsPanel component.

import type { IOProfile } from "../../hooks/useSettings";
import type { FramingEncoding } from '../../api/io';
import FramingOptionsPanel, {
  type FramingPanelConfig,
  hexToBytes,
} from "../../components/FramingOptionsPanel";
import { sectionHeader } from "../../styles/typography";
import { borderDivider } from "../../styles";

/** Framing configuration for the reader session */
export interface FramingConfig {
  /** Framing encoding: "slip", "modbus_rtu", "delimiter", or "raw" (no framing) */
  encoding: FramingEncoding;
  /** Delimiter bytes for delimiter-based framing (e.g., [0x0A] for LF) */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Also emit raw bytes in addition to frames */
  emitRawBytes?: boolean;
}

type Props = {
  /** Currently checked IO profile (single-select mode) */
  checkedProfile: IOProfile | null;
  /** All IO profiles (for multi-bus mode lookup) */
  ioProfiles?: IOProfile[];
  /** Selected profile IDs for multi-bus mode */
  checkedReaderIds?: string[];
  /** Whether ingesting is in progress */
  isIngesting: boolean;
  /** Current framing configuration */
  framingConfig: FramingConfig | null;
  /** Called when framing config changes */
  onFramingConfigChange: (config: FramingConfig | null) => void;
  /** Whether a bytes buffer is selected (framing can be applied to bytes buffers) */
  isBytesBufferSelected?: boolean;
};

/** Check if a profile supports framing (serial-based sources) */
function supportsFraming(profile: IOProfile | null): boolean {
  if (!profile) return false;
  // Serial port always supports framing
  if (profile.kind === "serial") return true;
  // PostgreSQL with serial_raw source type supports framing
  if (profile.kind === "postgres") {
    const sourceType = profile.connection?.source_type;
    return sourceType === "serial_raw";
  }
  return false;
}

/** Convert external FramingConfig to panel config */
function toPanelConfig(config: FramingConfig | null): FramingPanelConfig | null {
  if (!config || config.encoding === "raw") return null;

  return {
    mode: config.encoding,
    delimiterHex: config.delimiter
      ? config.delimiter.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("")
      : undefined,
    maxFrameLength: config.maxFrameLength,
    emitRawBytes: config.emitRawBytes,
  };
}

/** Convert panel config back to external FramingConfig */
function toFramingConfig(panelConfig: FramingPanelConfig | null): FramingConfig | null {
  if (!panelConfig || panelConfig.mode === "raw") return null;

  const config: FramingConfig = {
    encoding: panelConfig.mode,
    emitRawBytes: panelConfig.emitRawBytes,
  };

  if (panelConfig.mode === "delimiter") {
    config.delimiter = panelConfig.delimiterHex ? hexToBytes(panelConfig.delimiterHex) : [0x0a];
    config.maxFrameLength = panelConfig.maxFrameLength || 256;
  }

  return config;
}

export default function FramingOptions({
  checkedProfile,
  ioProfiles = [],
  checkedReaderIds = [],
  isIngesting,
  framingConfig,
  onFramingConfigChange,
  isBytesBufferSelected = false,
}: Props) {
  // Check if any selected profile in multi-bus mode supports framing
  const anyMultiBusProfileSupportsFraming = checkedReaderIds.some((id) => {
    const profile = ioProfiles.find((p) => p.id === id);
    return supportsFraming(profile || null);
  });

  // Show framing options if:
  // 1. A serial IO profile is selected (for capture with framing), OR
  // 2. Any profile in multi-bus selection supports framing, OR
  // 3. A bytes buffer is selected (to apply framing to existing bytes)
  // Don't show while ingesting
  const showFraming = (supportsFraming(checkedProfile) || anyMultiBusProfileSupportsFraming || isBytesBufferSelected) && !isIngesting;
  if (!showFraming) {
    return null;
  }

  const panelConfig = toPanelConfig(framingConfig);

  const handleChange = (newPanelConfig: FramingPanelConfig | null) => {
    onFramingConfigChange(toFramingConfig(newPanelConfig));
  };

  return (
    <div className={borderDivider}>
      <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
        Framing
      </div>
      <div className="p-3">
        <FramingOptionsPanel
          config={panelConfig}
          onChange={handleChange}
          variant="panel"
          showEmitRawBytes={true}
        />
      </div>
    </div>
  );
}
