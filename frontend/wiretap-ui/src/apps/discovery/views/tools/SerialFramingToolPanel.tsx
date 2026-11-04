// ui/src/apps/discovery/views/tools/SerialFramingToolPanel.tsx
//
// Options panel for Serial Framing Analysis tool in the Toolbox dialog.
// Analyzes raw bytes to detect framing protocol (SLIP, Modbus RTU, delimiters).

import { useTranslation } from "react-i18next";
import { Alert } from "../../../../components/Alert";

type Props = {
  bytesCount: number;
};

export default function SerialFramingToolPanel({ bytesCount }: Props) {
  const { t } = useTranslation("discovery");
  return (
    <div className="space-y-3 text-xs">
      <Alert tone="info" size="sm">
        <p className="font-medium">{t("toolPanels.serialFraming.title")}</p>
        <p className="mt-1">{t("toolPanels.serialFraming.description", { bytes: bytesCount.toLocaleString() })}</p>
      </Alert>
      <p className="text-muted">
        {t("toolPanels.serialFraming.willTest")}
      </p>
      <ul className="text-muted list-disc list-inside space-y-0.5">
        <li>{t("toolPanels.serialFraming.slip")}</li>
        <li>{t("toolPanels.serialFraming.modbusRtu")}</li>
        <li>{t("toolPanels.serialFraming.delimiters")}</li>
      </ul>
      <p className="text-muted mt-2 italic">
        {t("toolPanels.serialFraming.afterDetecting")}
      </p>
    </div>
  );
}
