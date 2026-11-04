// ui/src/apps/catalog/dialogs/AddNodeDialog.tsx

import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { useTranslation } from "react-i18next";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { caption } from "../../../styles";
import NodeDeviceAddressField from "./NodeDeviceAddressField";

export type AddNodeDialogProps = {
  open: boolean;

  nodeName: string;
  setNodeName: (v: string) => void;

  nodeNotes: string;
  setNodeNotes: (v: string) => void;

  /** Modbus catalogues: a node owns a device (slave) address. */
  showDeviceAddress?: boolean;
  deviceAddress?: number;
  setDeviceAddress?: (v: number | undefined) => void;

  onCancel: () => void;
  onAdd: () => void;
};

export default function AddNodeDialog({
  open,
  nodeName,
  setNodeName,
  nodeNotes,
  setNodeNotes,
  showDeviceAddress,
  deviceAddress,
  setDeviceAddress,
  onCancel,
  onAdd,
}: AddNodeDialogProps) {
  const { t } = useTranslation("catalog");
  return (
    <Dialog isOpen={open} onClose={onCancel} title={t("nodeDialog.addTitle")}>
      <DialogBody className="space-y-4">
        <FormField label={t("nodeDialog.name")} required variant="default">
          <Input
            size="lg"
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder={t("nodeDialog.namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nodeName.trim()) {
                onAdd();
              }
            }}
          />
          <p className={`mt-2 ${caption}`}>
            {t("nodeDialog.addHint")}
          </p>
        </FormField>

        <NodeDeviceAddressField
          show={showDeviceAddress}
          value={deviceAddress}
          onChange={setDeviceAddress}
        />

        <FormField label={t("shared.notes")} variant="default">
          <Textarea
            size="lg"
            value={nodeNotes}
            onChange={(e) => setNodeNotes(e.target.value)}
            placeholder={t("shared.notesPlaceholderNode")}
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onAdd} disabled={!nodeName.trim()}>
          {t("nodeDialog.addTitle")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
