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
import { Globe, Lock } from "lucide-react";
import * as ShareIcon from "../../../components/catalogIcons";
import Alert from "../../../components/Alert";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { FormField, Input, PrimaryButton, SecondaryButton } from "../../../components/forms";
import SettingRadioGroup from "../../settings/components/rows/SettingRadioGroup";
import { iconMd, iconSm } from "../../../styles/spacing";
import { caption, textDanger } from "../../../styles";
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
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={t("createRepo.title")}
      subtitle={t("createRepo.subtitle")}
    >
      <DialogBody className="space-y-4">
        <FormField label={t("createRepo.nameLabel")}>
          <Input
            size="lg"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="wiretap-catalogs"
            autoFocus
          />
        </FormField>

        <FormField label={t("createRepo.descriptionLabel")}>
          <Input
            size="lg"
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
          <Alert tone="warning">
            <p className="text-xs">{t("createRepo.publicWarning")}</p>
          </Alert>
        )}

        {!hasToken && <p className={`${caption} ${textDanger}`}>{t("createRepo.needsToken")}</p>}

        {account.error && (
          <Alert tone="danger">
            <p className="text-xs">{account.error.message}</p>
          </Alert>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("createRepo.cancel")}</SecondaryButton>
        <PrimaryButton
          onClick={() => void handleCreate()}
          disabled={!name.trim() || !hasToken || account.busy}
        >
          {account.busy && <ShareIcon.Busy className={`${iconMd} animate-spin`} />}
          {t("createRepo.create")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
