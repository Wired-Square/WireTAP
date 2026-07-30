// ui/src/apps/catalog/dialogs/CreateCatalogRepoDialog.tsx
//
// Create a repository to publish catalogues into, for someone with nowhere to put
// their work yet.
//
// Visibility defaults to private and going public is an explicit action: these files
// are reverse-engineering notes, so defaulting to public would be the wrong way
// round even though public is what sharing eventually wants.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Globe, Loader2, Lock } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { FormField, Input, PrimaryButton, SecondaryButton } from "../../../components/forms";
import SettingRadioGroup from "../../settings/components/rows/SettingRadioGroup";
import { iconMd, iconSm } from "../../../styles/spacing";
import { bgSurface, borderDivider, caption, h2, textDanger, textWarning } from "../../../styles";
import { alertDanger, alertWarning, panelFooter } from "../../../styles/cardStyles";
import { useCatalogShareStore } from "../../../stores/catalogShareStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new repository's URL, so publish can target it immediately. */
  onCreated?: (htmlUrl: string) => void;
};

export default function CreateCatalogRepoDialog({ isOpen, onClose, onCreated }: Props) {
  const { t } = useTranslation("catalog");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  const account = useCatalogShareStore((s) => s.account);
  const hasToken = useCatalogShareStore((s) => s.hasToken);
  const createRepo = useCatalogShareStore((s) => s.createRepo);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setDescription("");
    setIsPrivate(true);
  }, [isOpen]);

  const handleCreate = async () => {
    const repo = await createRepo(name, description || null, isPrivate);
    if (repo) {
      onCreated?.(repo.htmlUrl);
      onClose();
    }
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-lg">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("createRepo.title")}</h2>
          <p className={caption}>{t("createRepo.subtitle")}</p>
        </div>

        <div className="p-4 space-y-4">
          <FormField label={t("createRepo.nameLabel")}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="wiretap-catalogs"
              autoFocus
            />
          </FormField>

          <FormField label={t("createRepo.descriptionLabel")}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("createRepo.descriptionPlaceholder")}
            />
          </FormField>

          {/* Shared group so the two options are one radio set — arrow-key
              navigation and assistive tech depend on the shared `name`. */}
          <SettingRadioGroup
            name="repo-visibility"
            value={isPrivate ? "private" : "public"}
            onChange={(v) => setIsPrivate(v === "private")}
            stacked
            options={[
              {
                value: "private",
                label: (
                  <span className="inline-flex items-center gap-2">
                    <Lock className={iconSm} />
                    {t("createRepo.private")}
                  </span>
                ),
                description: t("createRepo.privateHint"),
              },
              {
                value: "public",
                label: (
                  <span className="inline-flex items-center gap-2">
                    <Globe className={iconSm} />
                    {t("createRepo.public")}
                  </span>
                ),
                description: t("createRepo.publicHint"),
              },
            ]}
          />

          {!isPrivate && (
            <div className={`${alertWarning} flex items-start gap-2`}>
              <AlertTriangle className={`${iconMd} ${textWarning} flex-shrink-0 mt-0.5`} />
              <p className={caption}>{t("createRepo.publicWarning")}</p>
            </div>
          )}

          {!hasToken && <p className={`${caption} ${textDanger}`}>{t("createRepo.needsToken")}</p>}

          {account.error && (
            <div className={`${alertDanger}`}>
              <p className={caption}>{account.error.message}</p>
            </div>
          )}
        </div>

        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>{t("createRepo.cancel")}</SecondaryButton>
          <PrimaryButton
            onClick={() => void handleCreate()}
            disabled={!name.trim() || !hasToken || account.busy}
          >
            {account.busy && <Loader2 className={`${iconMd} animate-spin`} />}
            {t("createRepo.create")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
