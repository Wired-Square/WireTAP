// ui/src/dialogs/AboutDialog.tsx

import { useEffect, useState } from "react";
import { X } from 'lucide-react';
import { useTranslation } from "react-i18next";
import { iconLg } from "../styles/spacing";
import { getAppVersion } from "../api";
import Dialog from "../components/Dialog";
import { PrimaryButton } from "../components/forms";
import { h1, h3, bodyDefault, bodySmall, borderDefault, hoverLight, roundedDefault, spaceYDefault, paddingDialog } from "../styles";

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const { t } = useTranslation("dialogs");
  const [version, setVersion] = useState<string>(t("about.loading"));

  useEffect(() => {
    if (!isOpen) return;
    getAppVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(t("about.unknown")));
  }, [isOpen, t]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose}>
      <div className={`${paddingDialog} max-h-[80vh] flex flex-col`}>
        <div className="flex items-start justify-between mb-4 shrink-0">
          <h2 className={h1}>{t("about.title")}</h2>
          <button
            onClick={onClose}
            className={`p-1 ${hoverLight} ${roundedDefault} transition-colors`}
          >
            <X className={`${iconLg} text-slate-500`} />
          </button>
        </div>

        <div className={`${spaceYDefault} ${bodyDefault} overflow-y-auto min-h-0`}>
          <div className="flex flex-col items-center text-center">
            <img src="/logo.svg" alt="WireTAP" className="w-14 h-14 rounded-2xl mb-2 bg-white p-1.5" />
            <p className="text-2xl font-bold font-ubuntu text-[color:var(--text-primary)]">WireTAP</p>
            <p className={`${bodySmall} font-ubuntu mt-1`}>{t("about.by")}</p>
            <p className={`${bodySmall} mt-1`}>{t("about.version", { version })}</p>
            <p className="text-xs italic opacity-50 mt-1">{t("about.tagline")}</p>
          </div>

          <p>{t("about.summary")}</p>

          <div className={`pt-3 border-t ${borderDefault}`}>
            <p className={`${h3} mb-2`}>{t("about.featuresTitle")}</p>
            <ul className={`${bodySmall} space-y-1 list-disc list-inside`}>
              <li>{t("about.features.canAnalysis")}</li>
              <li>{t("about.features.modbus")}</li>
              <li>{t("about.features.serial")}</li>
              <li>{t("about.features.mqttPostgres")}</li>
              <li>{t("about.features.multiSource")}</li>
              <li>{t("about.features.catalogue")}</li>
              <li>{t("about.features.transmission")}</li>
              <li>{t("about.features.graphing")}</li>
            </ul>
          </div>

          <div className={`pt-3 border-t ${borderDefault}`}>
            <p className={bodySmall}>
              <strong>{t("about.licenseLabel")}</strong> {t("about.licenseValue")}
            </p>
            <p className={bodySmall}>
              <strong>{t("about.copyrightLabel")}</strong> {t("about.copyrightValue")}
            </p>
          </div>
        </div>

        <div className="pt-4 shrink-0">
          <PrimaryButton onClick={onClose} className="w-full">
            {t("common:actions.close")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
