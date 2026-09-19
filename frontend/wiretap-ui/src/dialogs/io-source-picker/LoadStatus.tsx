// ui/src/dialogs/io-source-picker/LoadStatus.tsx

import { useTranslation } from "react-i18next";
import { Loader2, Square } from "lucide-react";
import { iconMd, iconXs } from "../../styles/spacing";
import {
  bgSuccess,
  borderSuccess,
  textSuccess,
  bgDanger,
  borderDanger,
  textDanger,
  gapSmall,
} from "../../styles";
import { Button } from "../../components/Button";

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
        <div className={`px-4 py-2 ${bgSuccess} border-b ${borderSuccess} flex items-center justify-between`}>
          <div className={`flex items-center ${gapSmall}`}>
            <Loader2 className={`${iconMd} animate-spin ${textSuccess}`} />
            <span className={`text-sm ${textSuccess}`}>
              {t("ioSourcePicker.loadingFrames", { count: loadFrameCount.toLocaleString() })}
            </span>
          </div>
          <Button
            onClick={onStopLoad}
            variant="solid"
            tone="danger"
            size="sm"
          >
            <Square className={iconXs} />
            <span>{t("ioSourcePicker.stop")}</span>
          </Button>
        </div>
      )}

      {/* Load Error */}
      {loadError && (
        <div className={`px-4 py-2 ${bgDanger} border-b ${borderDanger}`}>
          <div className={`text-xs ${textDanger}`}>{loadError}</div>
        </div>
      )}
    </>
  );
}
