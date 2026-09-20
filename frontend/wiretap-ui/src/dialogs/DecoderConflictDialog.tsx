
import { useTranslation } from "react-i18next";
import { textMedium, caption, hoverLight } from "../styles";
import Dialog, { DialogBody } from "../components/Dialog";

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
    <Dialog isOpen={isOpen} onClose={onClose} size="sm" title={t("decoderConflict.title")}>
      <DialogBody padding="none">
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
            <span className={`${textMedium} text-muted`}>
              {t("decoderConflict.none")}
            </span>
          </button>
        </div>
      </DialogBody>
    </Dialog>
  );
}
