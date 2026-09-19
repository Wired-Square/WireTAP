// ui/src/dialogs/io-source-picker/LoadStatus.tsx

import { useTranslation } from "react-i18next";
import { Loader2, Square } from "lucide-react";
import { iconXs } from "../../styles/spacing";
import { Button } from "../../components/Button";
import { Alert } from "../../components/Alert";
type Props = {
  isLoading: boolean;
  loadFrameCount: number;
  loadError: string | null;
  onStopLoad: () => void;
};

export default function LoadStatus({
  isLoading,
  loadFrameCount,
  loadError,
  onStopLoad,
}: Props) {
  const { t } = useTranslation("dialogs");
  return (
    <>
      {/* Load Status (when active) */}
      {isLoading && (
        <Alert
          tone="success"
          banner
          icon={<Loader2 className="animate-spin" />}
          action={
            <Button onClick={onStopLoad} variant="solid" tone="danger" size="sm">
              <Square className={iconXs} />
              <span>{t("ioSourcePicker.stop")}</span>
            </Button>
          }
        >
          {t("ioSourcePicker.loadingFrames", { count: loadFrameCount.toLocaleString() })}
        </Alert>
      )}

      {/* Load Error */}
      {loadError && (
        <Alert tone="danger" size="sm" banner>
          {loadError}
        </Alert>
      )}
    </>
  );
}
