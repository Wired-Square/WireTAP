// ui/src/apps/catalog/views/protocol-editors/CANConfigSection.tsx

import type { CANConfig } from "../../types";
import { flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium, focusRing, checkboxDefault } from "../../../../styles";

export type CANConfigSectionProps = {
  config: CANConfig;
  onChange: (config: CANConfig) => void;
  existingIds?: string[];
  originalId?: string;
};

export default function CANConfigSection({
  config,
  onChange,
}: CANConfigSectionProps) {
  return (
    <div className="space-y-4">
      {/* ID - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          ID <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={config.id}
          onChange={(e) => onChange({ ...config, id: e.target.value })}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing}`}
          placeholder="0x123"
        />
        <p className={`${caption} mt-1`}>
          Hex (0x123) or decimal (291) format
        </p>
      </div>

      {/* Extended ID checkbox */}
      <div className={flexRowGap2}>
        <input
          type="checkbox"
          id="extended"
          checked={config.extended ?? false}
          onChange={(e) => onChange({ ...config, extended: e.target.checked || undefined })}
          className={checkboxDefault}
        />
        <label htmlFor="extended" className="text-sm text-[color:var(--text-secondary)]">
          Extended ID (29-bit)
        </label>
      </div>

      {/* Bus - Optional */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Bus
        </label>
        <input
          type="number"
          min="0"
          value={config.bus ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              bus: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder="0"
        />
        <p className={`${caption} mt-1`}>
          CAN bus index (optional, for multi-bus systems)
        </p>
      </div>

      {/* Copy from - Optional (mutually exclusive with Mirror Of) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Copy From
        </label>
        <input
          type="text"
          value={config.copy ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              copy: e.target.value || undefined,
              mirror_of: undefined, // Clear mirror when setting copy
            })
          }
          disabled={!!config.mirror_of}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing} disabled:opacity-50 disabled:cursor-not-allowed`}
          placeholder="0x456"
        />
        <p className={`${caption} mt-1`}>
          Inherit metadata (length, transmitter, interval) from another frame
        </p>
      </div>

      {/* Mirror Of - Optional (mutually exclusive with Copy From) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Mirror Of
        </label>
        <input
          type="text"
          value={config.mirror_of ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              mirror_of: e.target.value || undefined,
              copy: undefined, // Clear copy when setting mirror
            })
          }
          disabled={!!config.copy}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing} disabled:opacity-50 disabled:cursor-not-allowed`}
          placeholder="0x456"
        />
        <p className={`${caption} mt-1`}>
          Inherit ALL signals from another frame (override by bit position)
        </p>
      </div>
    </div>
  );
}
