// ui/src/apps/catalog/views/CanConfigView.tsx

import { Network, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, iconButtonHover, bgSecondary } from "../../../styles";
import type { TomlNode, CanProtocolConfig } from "../types";

export type CanConfigViewProps = {
  selectedNode: TomlNode;
  canConfig?: CanProtocolConfig;
  onEditConfig?: () => void;
};

export default function CanConfigView({
  selectedNode,
  canConfig,
  onEditConfig,
}: CanConfigViewProps) {
  // Get values from canConfig (parsed from TOML) or fallback to node metadata
  const defaultEndianness = canConfig?.default_endianness ?? selectedNode.metadata?.properties?.default_endianness;
  const defaultInterval = canConfig?.default_interval ?? selectedNode.metadata?.properties?.default_interval;

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--status-success-bg)] rounded-lg">
            <Network className={`${iconLg} text-[color:var(--status-success)]`} />
          </div>
          <div>
            <div className="text-lg font-bold text-[color:var(--text-primary)]">
              CAN Configuration
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              Protocol-level settings for all CAN frames
            </p>
          </div>
        </div>
        {onEditConfig && (
          <button
            onClick={onEditConfig}
            className={iconButtonHover}
            title="Edit configuration"
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Default Endianness
          </div>
          <div className={monoBody}>
            {defaultEndianness ? (
              defaultEndianness === "little" ? "Little Endian" : "Big Endian"
            ) : (
              <span className="text-orange-500">Not set</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Default Interval
          </div>
          <div className={monoBody}>
            {defaultInterval !== undefined ? (
              `${defaultInterval} ms`
            ) : (
              <span className="text-slate-400">Not specified</span>
            )}
          </div>
        </div>
      </div>

      {/* Info box */}
      <div className="p-4 bg-[var(--status-info-bg)] rounded-lg border border-[color:var(--status-info-border)]">
        <p className="text-sm text-[color:var(--status-info)]">
          <strong>Note:</strong> Individual CAN frames inherit these settings.
          Frames can override the interval but will use the default endianness for signal decoding.
        </p>
      </div>
    </div>
  );
}
