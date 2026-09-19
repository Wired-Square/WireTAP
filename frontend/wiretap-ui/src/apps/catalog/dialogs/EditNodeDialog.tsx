// ui/src/apps/catalog/dialogs/EditNodeDialog.tsx

import { useMemo } from "react";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { caption } from "../../../styles";
import type { ValidationError } from "../types";
import NodeDeviceAddressField from "./NodeDeviceAddressField";

export type EditNodeDialogProps = {
  open: boolean;

  nodeName: string;
  setNodeName: (v: string) => void;

  nodeNotes: string;
  setNodeNotes: (v: string) => void;

  /** Modbus catalogues: a node owns a device (slave) address. */
  showDeviceAddress?: boolean;
  deviceAddress?: number;
  setDeviceAddress?: (v: number | undefined) => void;

  validationErrors: ValidationError[];
  clearValidation: () => void;

  onCancel: () => void;
  onSave: () => void;
};

export default function EditNodeDialog({
  open,
  nodeName,
  setNodeName,
  nodeNotes,
  setNodeNotes,
  showDeviceAddress,
  deviceAddress,
  setDeviceAddress,
  validationErrors,
  clearValidation,
  onCancel,
  onSave,
}: EditNodeDialogProps) {
  const nodeError = useMemo(() => validationErrors.find((e) => e.field === "node"), [validationErrors]);

  return (
    <Dialog isOpen={open} title="Edit Node">
      <DialogBody className="space-y-4">
        <FormField label="Node Name" required variant="default">
          <Input
            size="lg"
            value={nodeName}
            onChange={(e) => {
              setNodeName(e.target.value);
              if (nodeError) clearValidation();
            }}
            placeholder="inverter, battery, etc."
            onKeyDown={(e) => {
              if (e.key === "Enter" && nodeName.trim()) {
                onSave();
              }
            }}
          />
          {nodeError && (
            <p className="mt-2 text-sm text-[color:var(--danger)]">{nodeError.message}</p>
          )}
          <p className={`mt-2 ${caption}`}>
            Changing the name will update all frames that reference this node.
          </p>
        </FormField>

        <NodeDeviceAddressField
          show={showDeviceAddress}
          value={deviceAddress}
          onChange={setDeviceAddress}
        />

        <FormField label="Notes" variant="default">
          <Textarea
            size="lg"
            value={nodeNotes}
            onChange={(e) => setNodeNotes(e.target.value)}
            placeholder="Optional notes about this node..."
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={!nodeName.trim()}>
          Save Changes
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
