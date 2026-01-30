// ui/src/dialogs/io-reader-picker/FilterOptions.tsx
//
// Filter configuration options for serial data sources.
// Allows filtering frames during capture based on minimum length.
// Uses the shared FilterOptionsPanel component.

import type { IOProfile } from "../../hooks/useSettings";
import FilterOptionsPanel, { type FilterConfig } from "../../components/FilterOptionsPanel";
import { sectionHeader } from "../../styles/typography";
import { borderDivider } from "../../styles";

type Props = {
  /** Currently checked IO profile (single-select mode) */
  checkedProfile: IOProfile | null;
  /** All IO profiles (for multi-bus mode lookup) */
  ioProfiles?: IOProfile[];
  /** Selected profile IDs for multi-bus mode */
  checkedReaderIds?: string[];
  /** Whether ingesting is in progress */
  isIngesting: boolean;
  /** Current minimum frame length filter (0 = no filter) */
  minFrameLength: number;
  /** Called when filter config changes */
  onMinFrameLengthChange: (minLength: number) => void;
  /** Whether a bytes buffer is selected */
  isBytesBufferSelected?: boolean;
};

/** Check if a profile supports filtering (serial-based sources) */
function supportsFiltering(profile: IOProfile | null): boolean {
  if (!profile) return false;
  // Serial port always supports filtering
  if (profile.kind === "serial") return true;
  // PostgreSQL with serial_raw source type supports filtering
  if (profile.kind === "postgres") {
    const sourceType = profile.connection?.source_type;
    return sourceType === "serial_raw";
  }
  return false;
}

export default function FilterOptions({
  checkedProfile,
  ioProfiles = [],
  checkedReaderIds = [],
  isIngesting,
  minFrameLength,
  onMinFrameLengthChange,
  isBytesBufferSelected = false,
}: Props) {
  // Check if any selected profile in multi-bus mode supports filtering
  const anyMultiBusProfileSupportsFiltering = checkedReaderIds.some((id) => {
    const profile = ioProfiles.find((p) => p.id === id);
    return supportsFiltering(profile || null);
  });

  // Show filter options if:
  // 1. A serial IO profile is selected, OR
  // 2. Any profile in multi-bus selection supports filtering, OR
  // 3. A bytes buffer is selected
  // Don't show while ingesting
  const showFilter = (supportsFiltering(checkedProfile) || anyMultiBusProfileSupportsFiltering || isBytesBufferSelected) && !isIngesting;
  if (!showFilter) {
    return null;
  }

  const config: FilterConfig = { minFrameLength };

  const handleChange = (newConfig: FilterConfig) => {
    onMinFrameLengthChange(newConfig.minFrameLength);
  };

  return (
    <div className={borderDivider}>
      <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
        Filter
      </div>
      <div className="p-3">
        <FilterOptionsPanel
          config={config}
          onChange={handleChange}
          variant="panel"
        />
      </div>
    </div>
  );
}
