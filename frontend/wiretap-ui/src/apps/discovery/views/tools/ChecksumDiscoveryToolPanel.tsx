// ui/src/apps/discovery/views/tools/ChecksumDiscoveryToolPanel.tsx

import { useTranslation } from "react-i18next";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { toolPanelLabel } from "../../../../styles/inputStyles";
import { textMuted, textSecondary, borderDefault, bgSurface } from "../../../../styles/colourTokens";

/**
 * How checksum-shaped a byte has to look before the solver is asked about it.
 *
 * This is the only control the search still needs. Minimum Samples and Match
 * Threshold were cost knobs from when a CRC-16 sweep meant millions of IPC
 * round trips — the search is now milliseconds, so the question stopped being
 * "how much can I afford to look at" and became "how much noise will I read".
 */
const SENSITIVITY = [
  { value: 70, key: "strict" },
  { value: 50, key: "balanced" },
  { value: 0, key: "exhaustive" },
] as const;

export default function ChecksumDiscoveryToolPanel() {
  const { t } = useTranslation("discovery");
  const options = useDiscoveryStore((s) => s.toolbox.checksumDiscovery);
  const updateOptions = useDiscoveryStore((s) => s.updateChecksumDiscoveryOptions);

  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1">
        <label className={toolPanelLabel}>{t("checksumDiscovery.sensitivity")}</label>
        <select
          value={options.minLikeness ?? 50}
          onChange={(e) => updateOptions({ minLikeness: Number(e.target.value) })}
          className={`w-full px-2 py-1 rounded border ${borderDefault} ${bgSurface} text-[color:var(--text-primary)]`}
        >
          {SENSITIVITY.map(({ value, key }) => (
            <option key={key} value={value}>
              {t(`checksumDiscovery.sensitivityLevel.${key}`)}
            </option>
          ))}
        </select>
        <span className={`block ${textMuted}`}>
          {t(`checksumDiscovery.sensitivityHint.${
            SENSITIVITY.find((s) => s.value === (options.minLikeness ?? 50))?.key ?? "balanced"
          }`)}
        </span>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={options.searchCustomPolynomials}
          onChange={(e) => updateOptions({ searchCustomPolynomials: e.target.checked })}
          className="rounded mt-0.5"
        />
        <span>
          <span className={textSecondary}>{t("checksumDiscovery.searchCustomPolynomials")}</span>
          <span className={`block ${textMuted}`}>
            {t("checksumDiscovery.searchCustomPolynomialsHint")}
          </span>
        </span>
      </label>

      <p className={`${textMuted} pt-2 border-t ${borderDefault}`}>
        {t("checksumDiscovery.panelDescription")}
      </p>
    </div>
  );
}
