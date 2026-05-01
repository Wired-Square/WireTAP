// ui/src/dialogs/DecoderConflictDialog.tsx
//
// Disambiguation dialog shown when a multi-source session has profiles with
// different preferred decoders. Lets the user pick which one to use.

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconLg } from "../styles/spacing";
import { textMedium, caption, borderDivider, hoverLight, bgSurface } from "../styles";
import Dialog from "../components/Dialog";

export interface DecoderConflictOption {
  /** Catalog filename (from profile.preferred_catalog) */
  filename: string;
  /** Names of profiles that prefer this decoder */
  profileNames: string[];
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  options: DecoderConflictOption[];
  onSelect: (filename: string) => void;
  onSkip: () => void;
};

export default function DecoderConflictDialog({
  isOpen,
  onClose,
  options,
  onSelect,
  onSkip,
}: Props) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            {t("decoderConflict.title")}
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>
        <div className="px-4 py-2">
          <p className={`${caption}`}>{t("decoderConflict.intro")}</p>
        </div>
        <div className="py-1">
          {options.map((opt) => (
            <button
              key={opt.filename}
              onClick={() => {
                onSelect(opt.filename);
                onClose();
              }}
              className={`w-full px-4 py-2.5 flex items-center gap-3 text-left ${hoverLight} transition-colors`}
            >
              <div className="flex-1 min-w-0">
                <span className={`${textMedium} truncate`}>
                  {opt.filename}
                </span>
                <div className={`${caption} truncate`}>
                  {t("decoderConflict.usedBy", { profiles: opt.profileNames.join(", ") })}
                </div>
              </div>
            </button>
          ))}
          <button
            onClick={() => {
              onSkip();
              onClose();
            }}
            className={`w-full px-4 py-2.5 text-left ${hoverLight} transition-colors`}
          >
            <span className={`${textMedium} text-[color:var(--text-muted)]`}>
              {t("decoderConflict.none")}
            </span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
