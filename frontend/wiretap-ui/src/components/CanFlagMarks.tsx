import { useTranslation } from "react-i18next";
import { Badge } from "./Badge";
import { textMuted } from "../styles";

export function RemoteRequest({ dlc }: { dlc?: number }) {
  const { t } = useTranslation("common");
  return <span className={textMuted}>{t("canFlags.remoteRequest", { count: dlc ?? 0 })}</span>;
}

export function CanFlagBadges({ brs, esi }: { brs?: boolean; esi?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <>
      {brs && <Badge size="sm" tone="cyan" className="ml-2" title={t("canFlags.brs")}>BRS</Badge>}
      {esi && <Badge size="sm" tone="warning" className="ml-2" title={t("canFlags.esi")}>ESI</Badge>}
    </>
  );
}
