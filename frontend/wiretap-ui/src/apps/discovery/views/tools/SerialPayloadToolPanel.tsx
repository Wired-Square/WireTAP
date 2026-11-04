// ui/src/apps/discovery/views/tools/SerialPayloadToolPanel.tsx
//
// Options panel for Serial Payload Analysis tool in the Toolbox dialog.
// Analyzes framed data to identify ID bytes and checksum positions.

import { useTranslation } from "react-i18next";
import { Alert } from "../../../../components/Alert";

type Props = {
  framesCount: number;
};

export default function SerialPayloadToolPanel({ framesCount }: Props) {
  const { t } = useTranslation("discovery");
  return (
    <div className="space-y-3 text-xs">
      <Alert tone="success" size="sm">
        <p className="font-medium">{t("toolPanels.serialPayload.title")}</p>
        <p className="mt-1">{t("toolPanels.serialPayload.description", { frames: framesCount.toLocaleString() })}</p>
      </Alert>
      <p className="text-muted">
        {t("toolPanels.serialPayload.willIdentify")}
      </p>
      <ul className="text-muted list-disc list-inside space-y-0.5">
        <li>{t("toolPanels.serialPayload.idBytes")}</li>
        <li>{t("toolPanels.serialPayload.sourceAddress")}</li>
        <li>{t("toolPanels.serialPayload.checksums")}</li>
      </ul>
      <p className="text-muted mt-2 italic">
        {t("toolPanels.serialPayload.worksBest")}
      </p>
    </div>
  );
}
