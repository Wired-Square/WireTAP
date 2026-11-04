// ui/src/apps/discovery/views/tools/ChangesToolPanel.tsx

import { useTranslation } from "react-i18next";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { toolPanelLabel } from "../../../../styles/typography";
import { textMuted } from "../../../../styles/colourTokens";
import { Input } from "../../../../components/forms";

export default function ChangesToolPanel() {
  const { t } = useTranslation("discovery");
  const options = useDiscoveryStore((s) => s.toolbox.changes);
  const updateOptions = useDiscoveryStore((s) => s.updateChangesOptions);

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-1">
        <label className={toolPanelLabel}>{t("toolPanels.changes.maxExamples")}</label>
        <Input
          type="number"
          min={1}
          max={100}
          value={options.maxExamples}
          onChange={(e) => updateOptions({ maxExamples: Math.max(1, Math.min(100, Number(e.target.value) || 30)) })}
        />
      </div>
      <p className={textMuted}>
        {t("toolPanels.changes.maxExamplesHint")}
      </p>
    </div>
  );
}
