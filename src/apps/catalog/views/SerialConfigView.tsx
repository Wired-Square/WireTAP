// ui/src/apps/catalog/views/SerialConfigView.tsx

import { Cable, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, iconButtonHover, bgSecondary } from "../../../styles";
import type { TomlNode } from "../types";

export type SerialConfigViewProps = {
  selectedNode: TomlNode;
  onEditConfig?: () => void;
};

const encodingLabels: Record<string, string> = {
  slip: "SLIP (RFC 1055)",
  cobs: "COBS",
  raw: "Raw (delimiter-based)",
  length_prefixed: "Length Prefixed",
};

export default function SerialConfigView({
  selectedNode,
  onEditConfig,
}: SerialConfigViewProps) {
  const encoding = selectedNode.metadata?.encoding;

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--purple-bg)] rounded-lg">
            <Cable className={`${iconLg} text-[color:var(--purple-text)]`} />
          </div>
          <div>
            <div className="text-lg font-bold text-[color:var(--text-primary)]">
              Serial Configuration
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              Protocol-level settings for all serial frames
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
        <div className={`p-4 ${bgSecondary} rounded-lg col-span-2`}>
          <div className={labelSmallMuted}>
            Encoding
          </div>
          <div className={monoBody}>
            {encoding ? (
              <span className="uppercase">{encodingLabels[encoding] || encoding}</span>
            ) : (
              <span className="text-orange-500">Not set</span>
            )}
          </div>
          <p className={`${caption} mt-2`}>
            This encoding applies to all serial frames in the catalog.
          </p>
        </div>
      </div>

      {/* Info box */}
      <div className="p-4 bg-[var(--info-bg)] rounded-lg border border-[color:var(--info-border)]">
        <p className="text-sm text-[color:var(--info-text)]">
          <strong>Note:</strong> Individual serial frames inherit this encoding.
          To change the encoding, click the edit button above.
        </p>
      </div>
    </div>
  );
}
